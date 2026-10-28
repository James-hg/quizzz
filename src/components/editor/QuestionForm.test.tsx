// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  describe("image", () => {
    const valid = {
      ...emptyDraft(),
      prompt: "What is shown?",
      options: [
        { id: "o1", text: "A cat" },
        { id: "o2", text: "A dog" },
      ],
      correctOptionIds: ["o1"],
    };
    const png = () => new File([new Uint8Array(10)], "cat.png", { type: "image/png" });

    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => "blob:preview");
      URL.revokeObjectURL = vi.fn();
    });

    it("shows a saved image and keeps it when nothing about it changed", async () => {
      const { onSubmit, user } = setup({
        initial: valid,
        initialImage: { id: "i1", url: "/api/images/i1", alt: "A cat" },
      });
      expect(screen.getByRole("img", { name: "A cat" })).toHaveAttribute("src", "/api/images/i1");
      await user.click(screen.getByRole("button", { name: "Save question" }));
      expect(onSubmit.mock.calls[0]![1]).toEqual({ type: "keep" });
    });

    it("uploads a chosen file once it has a description, and previews it", async () => {
      const { onSubmit, user } = setup({ initial: valid });
      await user.upload(screen.getByLabelText("Choose an image"), png());
      expect(screen.getByRole("img")).toHaveAttribute("src", "blob:preview");

      await user.click(screen.getByRole("button", { name: "Save question" }));
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getAllByText(/Describe the image/).length).toBeGreaterThan(0);

      await user.type(screen.getByLabelText("Describe the image"), "A cat on a sofa");
      await user.click(screen.getByRole("button", { name: "Save question" }));
      const change = onSubmit.mock.calls[0]![1];
      expect(change).toMatchObject({ type: "upload", alt: "A cat on a sofa" });
      expect(change.file.name).toBe("cat.png");
    });

    it("refuses an unsupported file straight away", async () => {
      const { user } = setup({ initial: valid });
      const svg = new File(["<svg/>"], "a.svg", { type: "image/svg+xml" });
      // The picker only offers images, so bypass the accept filter as a drag-and-drop would.
      await userEvent
        .setup({ applyAccept: false })
        .upload(screen.getByLabelText("Choose an image"), svg);
      expect(screen.getByText("Only PNG, JPEG or WebP images are supported.")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      void user;
    });

    it("removes a saved image", async () => {
      const { onSubmit, user } = setup({
        initial: valid,
        initialImage: { id: "i1", url: "/api/images/i1", alt: "A cat" },
      });
      await user.click(screen.getByRole("button", { name: "Remove image" }));
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save question" }));
      expect(onSubmit.mock.calls[0]![1]).toEqual({ type: "remove" });
    });

    it("sends only the new description when the alt text is edited", async () => {
      const { onSubmit, user } = setup({
        initial: valid,
        initialImage: { id: "i1", url: "/api/images/i1", alt: "A cat" },
      });
      const alt = screen.getByLabelText("Describe the image");
      await user.clear(alt);
      await user.type(alt, "A black cat");
      await user.click(screen.getByRole("button", { name: "Save question" }));
      expect(onSubmit.mock.calls[0]![1]).toEqual({
        type: "alt",
        imageId: "i1",
        alt: "A black cat",
      });
    });
  });
});
