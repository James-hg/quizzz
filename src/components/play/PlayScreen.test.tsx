// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaySession } from "@/lib/client/types";
import { PlayScreen } from "./PlayScreen";
import { result, session } from "./test-helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let handlers: ((call: Call) => Response | Promise<Response> | undefined)[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  handlers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      for (const handler of handlers) {
        const response = await handler(call);
        if (response) return response;
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const second: PlaySession = session({
  progress: { total: 2, answered: 1, removed: 0 },
  items: [
    { questionId: "q1", position: 0, status: "answered", result: result("correct") },
    { questionId: "q2", position: 1, status: "pending" },
  ],
  current: { ...session().current!, questionId: "q2", prompt: "Second question" },
});

function setup(initial: PlaySession = session()) {
  render(<PlayScreen initial={initial} setTitle="Week 1" />);
  return userEvent.setup();
}

describe("PlayScreen", () => {
  it("shows the question without any answer information and waits for a choice", () => {
    setup();
    expect(screen.getByText("Pick b")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
    expect(screen.queryByText(/correct answer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/explanation/i)).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progress" })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("submits with an idempotency key, then shows feedback and moves on", async () => {
    handlers.push(
      (c) =>
        c.url === "/api/sessions/s1/answers"
          ? json(
              {
                replayed: false,
                result: { ...result("correct"), explanation: "Because b." },
                progress: { answered: 1, total: 2 },
              },
              201,
            )
          : undefined,
      (c) =>
        c.url === "/api/sessions/s1" && c.method === "GET" ? json({ session: second }) : undefined,
    );
    const user = setup();

    await user.click(screen.getByLabelText("B"));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(await screen.findByText(/Correct/)).toBeInTheDocument();
    expect(screen.getByText("Because b.")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      questionId: "q1",
      response: { kind: "options", selectedOptionIds: ["b"] },
    });
    expect(typeof (post.body as { idempotencyKey: string }).idempotencyKey).toBe("string");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Second question")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
  });

  it("retries a failed submit with the same idempotency key", async () => {
    let attempts = 0;
    handlers.push((c) => {
      if (c.url !== "/api/sessions/s1/answers") return undefined;
      attempts++;
      if (attempts === 1) throw new TypeError("network down");
      return json(
        { replayed: false, result: result("incorrect"), progress: { answered: 1, total: 2 } },
        201,
      );
    });
    const user = setup();

    await user.click(screen.getByLabelText("A"));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the server/i);

    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(await screen.findByText(/Not quite/)).toBeInTheDocument();

    const keys = calls
      .filter((c) => c.method === "POST")
      .map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("pauses to a paused screen without the question, and resumes", async () => {
    handlers.push((c) => {
      if (c.method !== "PATCH") return undefined;
      const action = (c.body as { action: string }).action;
      return json({
        session: session({ state: action === "pause" ? "paused" : "active", elapsedSeconds: 30 }),
      });
    });
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("heading", { name: "Paused" })).toBeInTheDocument();
    expect(screen.queryByText("Pick b")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Pick b")).toBeInTheDocument();
  });

  it("ends the session after confirmation and shows the summary", async () => {
    const done = session({
      state: "completed",
      current: null,
      elapsedSeconds: 65,
      progress: { total: 2, answered: 1, removed: 0 },
      items: [
        { questionId: "q1", position: 0, status: "answered", result: result("correct") },
        { questionId: "q2", position: 1, status: "pending" },
      ],
    });
    handlers.push((c) =>
      c.url === "/api/sessions/s1/complete"
        ? json({
            session: done,
            summary: {
              totalItems: 2,
              answered: 1,
              correct: 1,
              incorrect: 0,
              uncertain: 0,
              unanswered: 1,
              elapsedSeconds: 65,
            },
          })
        : undefined,
    );
    const user = setup();

    await user.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Yes, end it" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Yes, end it" }));

    expect(await screen.findByRole("heading", { name: "Session complete" })).toBeInTheDocument();
    expect(screen.getByText("1 correct out of 1 answered")).toBeInTheDocument();
    expect(screen.getByText(/Time: 1:05/)).toBeInTheDocument();
  });

  it("shows the summary straight away when a finished session is opened", () => {
    setup(
      session({
        state: "completed",
        current: null,
        items: [],
        progress: { total: 0, answered: 0, removed: 0 },
      }),
    );
    expect(screen.getByRole("heading", { name: "Session complete" })).toBeInTheDocument();
  });

  it("shows the question's image with its alt text, and nothing when there is none", () => {
    const withImage = session({
      current: {
        ...session().current!,
        image: { id: "i1", url: "/api/images/i1", alt: "A cat on a sofa" },
      },
    });
    setup(withImage);
    const img = screen.getByRole("img", { name: "A cat on a sofa" });
    expect(img).toHaveAttribute("src", "/api/images/i1");
    cleanup();

    setup(session());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
