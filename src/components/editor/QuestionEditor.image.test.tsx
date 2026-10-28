// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionEditor } from "./QuestionEditor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

type Call = { url: string; method: string };
let calls: Call[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillAndSave(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add question" }));
  await user.type(screen.getByLabelText("Question"), "What is shown?");
  await user.type(screen.getByLabelText("Option 1 text"), "A cat");
  await user.type(screen.getByLabelText("Option 2 text"), "A dog");
  await user.click(screen.getByLabelText("Option 1 is correct"));
  await user.upload(
    screen.getByLabelText("Choose an image"),
    new File([new Uint8Array(10)], "cat.png", { type: "image/png" }),
  );
  await user.type(screen.getByLabelText("Describe the image"), "A cat");
  await user.click(screen.getByRole("button", { name: "Add question" }));
}

describe("QuestionEditor image upload", () => {
  it("uploads the picture, then saves the question with a reference to it", async () => {
    let body: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/images")) return json({ image: { id: "img-1" } }, 201);
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return json({ question: { id: "q1" } }, 201);
      }),
    );
    const user = userEvent.setup();
    render(<QuestionEditor questionSetId="s1" questions={[]} />);
    await fillAndSave(user);

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.url)).toEqual([
      "/api/question-sets/s1/images",
      "/api/question-sets/s1/questions",
    ]);
    expect(body).toMatchObject({ image: { imageId: "img-1", alt: "A cat" } });
  });

  it("discards the uploaded picture when the question then fails to save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/images")) return json({ image: { id: "img-9" } }, 201);
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return json({ error: { code: "validation_error", message: "Could not save" } }, 400);
      }),
    );
    const user = userEvent.setup();
    render(<QuestionEditor questionSetId="s1" questions={[]} />);
    await fillAndSave(user);

    expect(await screen.findByText("Could not save")).toBeInTheDocument();
    await waitFor(() =>
      expect(calls).toContainEqual({ url: "/api/images/img-9", method: "DELETE" }),
    );
  });

  it("does not upload anything when the image is unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        return json({ question: { id: "q1" } });
      }),
    );
    const user = userEvent.setup();
    render(
      <QuestionEditor
        questionSetId="s1"
        questions={[
          {
            id: "q1",
            questionSetId: "s1",
            position: 0,
            status: "active",
            revisionId: "r1",
            revisionNumber: 1,
            type: "short_answer",
            prompt: "Name it",
            codeSnippet: null,
            options: [],
            answerKey: { kind: "text", accepted: ["cat"], caseSensitive: false },
            explanation: null,
            origin: "original",
            evidenceStatus: "human_reviewed",
            image: { id: "img-1", url: "/api/images/img-1", alt: "A cat" },
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save as new revision" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/questions/q1", method: "PATCH" });
  });
});
