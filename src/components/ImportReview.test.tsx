// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportItemView, ImportView } from "@/lib/client/types";
import { ImportReview } from "./ImportReview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

type Payload = Extract<ImportItemView["payload"], { kind: "question" }>;

function item(
  id: string,
  position: number,
  payload: Partial<Payload> & { prompt: string },
  decision: ImportItemView["decision"] = "pending",
): ImportItemView {
  return {
    id,
    position,
    kind: "question",
    decision,
    warnings: [],
    sources: [],
    payload: {
      kind: "question",
      type: "mcq_single",
      options: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
      correctOptionIds: ["a"],
      ...payload,
    },
  };
}

function draft(items: ImportItemView[]): ImportView {
  return {
    id: "d1",
    courseId: "c1",
    status: "extracted",
    errorMessage: null,
    warnings: [],
    publishedQuestionSetId: null,
    source: { filename: "quiz.docx", sizeBytes: 1000 },
    items,
  };
}

let requests: { url: string; method: string; body: unknown }[];
let respond: (body: unknown) => ImportView;

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method: init?.method ?? "GET", body });
      return new Response(JSON.stringify({ import: respond(body) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (initial: ImportView) =>
  render(<ImportReview initial={initial} existingSets={[]} defaultTitle="Quiz" />);

describe("Remove question number toggle", () => {
  it("offers a toggle only for prompts that carry a number", () => {
    view(
      draft([
        item("i1", 0, { prompt: "1. What is X?" }),
        item("i2", 1, { prompt: "2 + 2 = ?" }),
        item("i3", 2, { prompt: "What is Z?", originalPrompt: "3. What is Z?" }),
      ]),
    );
    expect(screen.getAllByLabelText("Remove question number")).toHaveLength(2);
    const second = screen.getByRole("article", { name: "Question 2" });
    expect(within(second).queryByLabelText("Remove question number")).not.toBeInTheDocument();
  });

  it("previews the stripped text before applying, and shows the original once applied", () => {
    view(
      draft([
        item("i1", 0, { prompt: "1. What is X?" }),
        item("i3", 1, { prompt: "What is Z?", originalPrompt: "3. What is Z?" }),
      ]),
    );
    const first = screen.getByRole("article", { name: "Question 1" });
    expect(within(first).getByLabelText("Remove question number")).not.toBeChecked();
    expect(within(first).getByText(/Would become:/)).toHaveTextContent("What is X?");

    const second = screen.getByRole("article", { name: "Question 2" });
    expect(within(second).getByLabelText("Remove question number")).toBeChecked();
    expect(within(second).getByText(/Original:/)).toHaveTextContent("3. What is Z?");
  });

  it("applies through the item edit endpoint without accepting a pending item", async () => {
    respond = () =>
      draft([item("i1", 0, { prompt: "What is X?", originalPrompt: "1. What is X?" }, "pending")]);
    const user = userEvent.setup();
    view(draft([item("i1", 0, { prompt: "1. What is X?" })]));

    await user.click(screen.getByLabelText("Remove question number"));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "/api/imports/d1/items/i1",
      method: "PATCH",
      body: {
        edit: { prompt: "What is X?", originalPrompt: "1. What is X?" },
        decision: "pending",
      },
    });
    await waitFor(() => expect(screen.getByLabelText("Remove question number")).toBeChecked());
  });

  it("restores the exact original when unchecked", async () => {
    respond = () => draft([item("i1", 0, { prompt: "Question 2: What is X?" })]);
    const user = userEvent.setup();
    view(
      draft([item("i1", 0, { prompt: "What is X?", originalPrompt: "Question 2: What is X?" })]),
    );

    await user.click(screen.getByLabelText("Remove question number"));

    expect(requests[0]!.body).toMatchObject({
      edit: { prompt: "Question 2: What is X?", originalPrompt: null },
    });
    await waitFor(() => expect(screen.getByLabelText("Remove question number")).not.toBeChecked());
  });

  it("keeps an accepted item accepted and an excluded item excluded", async () => {
    const initial = draft([
      item("e1", 0, { prompt: "1. Edited one" }, "edited"),
      item("x1", 1, { prompt: "2. Excluded one" }, "excluded"),
    ]);
    respond = () => initial;
    const user = userEvent.setup();
    view(initial);
    const [first, second] = screen.getAllByLabelText("Remove question number");
    await user.click(first!);
    await user.click(second!);

    expect(requests.map((r) => (r.body as { decision: string }).decision)).toEqual([
      "accepted",
      "excluded",
    ]);
  });

  it("hides the toggle once the import is published", () => {
    view({
      ...draft([item("i1", 0, { prompt: "1. What is X?" }, "accepted")]),
      status: "published",
      publishedQuestionSetId: "s1",
    });
    expect(screen.queryByLabelText("Remove question number")).not.toBeInTheDocument();
  });

  it("clears the remembered original when you type your own wording", async () => {
    respond = () => draft([]);
    const user = userEvent.setup();
    view(draft([item("i1", 0, { prompt: "What is X?", originalPrompt: "1. What is X?" })]));

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Question");
    await user.clear(box);
    await user.type(box, "What is Y?");
    await user.click(screen.getByRole("button", { name: "Save and accept" }));

    expect(requests[0]!.body).toMatchObject({
      edit: { prompt: "What is Y?", originalPrompt: null },
      decision: "accepted",
    });
  });

  it("leaves the remembered original alone when only options change", async () => {
    respond = () => draft([]);
    const user = userEvent.setup();
    view(draft([item("i1", 0, { prompt: "What is X?", originalPrompt: "1. What is X?" })]));

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save and accept" }));

    expect((requests[0]!.body as { edit: Record<string, unknown> }).edit).not.toHaveProperty(
      "originalPrompt",
    );
  });

  describe("images from the document", () => {
    const image = (alt: string) => ({ imageId: "11111111-1111-4111-8111-111111111111", alt });

    it("shows the picture with its description", () => {
      view(draft([item("i1", 0, { prompt: "What is shown?", image: image("A stack of plates") })]));
      expect(screen.getByRole("img", { name: "A stack of plates" })).toHaveAttribute(
        "src",
        "/api/images/11111111-1111-4111-8111-111111111111",
      );
      expect(screen.getByLabelText("Describe the image")).toHaveValue("A stack of plates");
    });

    it("cannot be accepted until the image has a description", () => {
      view(draft([item("i1", 0, { prompt: "What is shown?", image: image("") })]));
      expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
      expect(screen.getByText(/Required: the question can be accepted/)).toBeInTheDocument();
    });

    it("saves a description without accepting or excluding the item", async () => {
      const initial = draft([item("i1", 0, { prompt: "What is shown?", image: image("") })]);
      respond = () => initial;
      const user = userEvent.setup();
      view(initial);

      await user.type(screen.getByLabelText("Describe the image"), "  A stack of plates ");
      await user.click(screen.getByRole("button", { name: "Save description" }));

      expect(requests[0]).toMatchObject({
        url: "/api/imports/d1/items/i1",
        method: "PATCH",
        body: {
          edit: {
            image: { imageId: "11111111-1111-4111-8111-111111111111", alt: "A stack of plates" },
          },
          decision: "pending",
        },
      });
    });

    it("drops the image on request", async () => {
      const initial = draft([item("i1", 0, { prompt: "What is shown?", image: image("Plates") })]);
      respond = () => initial;
      const user = userEvent.setup();
      view(initial);
      await user.click(screen.getByRole("button", { name: "Remove image" }));
      expect(requests[0]!.body).toMatchObject({ edit: { image: null }, decision: "pending" });
    });

    it("shows no image controls for questions without one, or once published", () => {
      view(draft([item("i1", 0, { prompt: "Plain question" })]));
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      cleanup();
      view({
        ...draft([item("i1", 0, { prompt: "Q", image: image("Plates") }, "accepted")]),
        status: "published",
        publishedQuestionSetId: "s1",
      });
      expect(screen.getByRole("img", { name: "Plates" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Describe the image")).not.toBeInTheDocument();
    });
  });
});
