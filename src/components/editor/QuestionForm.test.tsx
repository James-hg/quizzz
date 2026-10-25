// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDraft } from "./draft";
import { QuestionForm } from "./QuestionForm";

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof QuestionForm>[0]> = {}) {
  const onSubmit = vi.fn();
  render(
    <QuestionForm
      initial={emptyDraft()}
      submitLabel="Save question"
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit, user: userEvent.setup() };
}

describe("QuestionForm validation", () => {
  it("does not submit an empty question and explains what is missing", async () => {
    const { onSubmit, user } = setup();
    await user.click(screen.getByRole("button", { name: "Save question" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText("Write the question.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Every option needs text.").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Question")).toHaveAttribute("aria-invalid", "true");
  });

  it("requires a correct answer before submitting", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText("Question"), "Pick b");
    await user.type(screen.getByLabelText("Option 1 text"), "A");
    await user.type(screen.getByLabelText("Option 2 text"), "B");
    await user.click(screen.getByRole("button", { name: "Save question" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText("Choose the correct answer.").length).toBeGreaterThan(0);
  });

  it("submits a valid question with the chosen answer and approval", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText("Question"), "Pick b");
    await user.type(screen.getByLabelText("Option 1 text"), "A");
    await user.type(screen.getByLabelText("Option 2 text"), "B");
    await user.click(screen.getByLabelText("Option 2 is correct"));
    await user.click(screen.getByRole("button", { name: "Save question" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      type: "mcq_single",
      prompt: "Pick b",
      options: [
        { id: "o1", text: "A" },
        { id: "o2", text: "B" },
      ],
      correctOptionIds: ["o2"],
      approve: true,
    });
  });

  it("lets only one option be correct for single-answer questions", async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText("Option 1 is correct"));
    await user.click(screen.getByLabelText("Option 2 is correct"));
    expect(screen.getByLabelText("Option 1 is correct")).not.toBeChecked();
    expect(screen.getByLabelText("Option 2 is correct")).toBeChecked();
  });

  it("switches to text answers and requires an accepted answer", async () => {
    const { onSubmit, user } = setup();
    await user.selectOptions(screen.getByLabelText("Question type"), "short_answer");
    await user.type(screen.getByLabelText("Question"), "Name an immutable type");
    await user.click(screen.getByRole("button", { name: "Save question" }));
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Accepted answer 1"), "tuple");
    await user.click(screen.getByRole("button", { name: "Save question" }));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ type: "short_answer", accepted: ["tuple"] });
  });

  it("shows a server error without losing what was typed", async () => {
    const { user } = setup({ serverError: "Could not save" });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
    await user.type(screen.getByLabelText("Question"), "Still here");
    expect(screen.getByLabelText("Question")).toHaveValue("Still here");
  });

  it("shows no review tick for questions the owner wrote", async () => {
    setup({ showApprove: false });
    expect(screen.queryByLabelText(/I have reviewed this question/)).not.toBeInTheDocument();
    expect(screen.queryByText(/did not come from you/)).not.toBeInTheDocument();
  });

  it("asks for an explicit review tick on AI and sample questions, and sends it", async () => {
    const { onSubmit, user } = setup({
      initial: {
        ...emptyDraft(),
        prompt: "Pick b",
        approve: false,
        options: [
          { id: "o1", text: "A" },
          { id: "o2", text: "B" },
        ],
        correctOptionIds: ["o2"],
      },
    });
    const tick = screen.getByLabelText("I have reviewed this question and its answer");
    expect(tick).not.toBeChecked();
    expect(screen.getByText(/stays out of practice until you tick this/)).toBeInTheDocument();
    await user.click(tick);
    await user.click(screen.getByRole("button", { name: "Save question" }));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ approve: true });
  });
});
