// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const props = { questionSetId: "s1", courseId: "c1", setTitle: "Week 1" };

describe("AssistantPanel", () => {
  it("explains that AI is off and offers no AI controls when disabled", () => {
    render(<AssistantPanel enabled={false} {...props} />);
    expect(screen.getByText(/AI help is turned off on this server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Your question")).not.toBeInTheDocument();
  });

  it("shows a clear message when the AI service is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "ai_unavailable", message: "AI help is not available right now." },
            }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );
    const user = userEvent.setup();
    render(<AssistantPanel enabled {...props} />);
    await user.type(screen.getByLabelText("Your question"), "What is a tuple?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AI help is not available right now.",
    );
    // Nothing was added to the conversation, and the question is still there to retry.
    expect(screen.getByLabelText("Your question")).toHaveValue("What is a tuple?");
  });
});
