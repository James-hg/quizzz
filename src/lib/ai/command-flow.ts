import {
  buildShuffledQuestionOrder,
  mergeQuestionGenerationRequest,
  parseCorrectAnswer,
  parseEditorIntent,
  parseOptionList,
  resolveQuestionTarget,
  summarizeQuestion,
  type EditableQuestion,
  type ParsedEditorIntent,
  type QuestionTargetReference,
  type ResolvedQuestionTarget,
} from "./editor-intents";

/**
 * The editor assistant's command conversation as a pure state machine: it decides what to say
 * and which action to run, and never touches the network. The panel runs the actions through
 * the app's own API after the user confirms, so every change is an ordinary, revisioned edit.
 */

export type CommandQuestion = EditableQuestion & { type: string };

export type FlowContext = {
  questions: CommandQuestion[];
  setTitle: string;
  aiEnabled: boolean;
};

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const OPTION_IDS = "abcdefghij";

export type Effect =
  | { type: "rename_set"; title: string }
  | { type: "create_set"; title: string }
  | { type: "reorder"; questionIds: string[] }
  | { type: "shuffle_choices"; questionIds: string[] }
  | { type: "add_question"; prompt: string; options: string[]; correctIndex: number }
  | {
      type: "update_question";
      questionId: string;
      label: string;
      patch: {
        prompt?: string;
        options?: { id: string; text: string }[];
        correctOptionIds?: string[];
      };
    }
  | { type: "delete_question"; questionId: string; label: string }
  | { type: "exclude_question"; questionId: string; label: string }
  // These two call the AI and run right away; nothing changes until the user confirms.
  | { type: "suggest_title" }
  | { type: "generate"; count: number; topic?: string };

type UpdateChanges = { text?: string; options?: string[]; correct?: string | number };
type TextTarget = { question: CommandQuestion; index: number };

export type Pending =
  | { kind: "none" }
  | { kind: "confirm"; effect: Effect; preview: string[] }
  | { kind: "ask_rename_title" }
  | { kind: "ask_create_title" }
  | { kind: "ask_generate"; count?: number; topic?: string }
  | {
      kind: "ask_target";
      action: "remove" | "update";
      changes: UpdateChanges;
      candidates?: number[];
    }
  | { kind: "add_text" }
  | { kind: "add_options"; text: string }
  | { kind: "add_correct"; text: string; options: string[] }
  | { kind: "update_text"; target: TextTarget; changes: UpdateChanges }
  | { kind: "update_options"; target: TextTarget; changes: UpdateChanges }
  | { kind: "update_correct"; target: TextTarget; changes: UpdateChanges };

export type FlowResult = {
  state: Pending;
  /** What the assistant says, in order. */
  messages: string[];
  /** An action to run now. The panel reports back with `afterEffect`. */
  run?: Effect;
  /** The message is not a command: the AI chat may answer it (the panel checks AI is on). */
  passToAi?: boolean;
};

export type Outcome = { ok: true; data?: unknown } | { ok: false; code: string; message: string };

export const START: Pending = { kind: "none" };

const CANCEL = /^(cancel|stop|never ?mind|abort|no|nope|n)$/i;
const YES = /^(yes|y|yep|yeah|confirm|ok|okay|sure|do it|apply|go ahead)$/i;
const SKIP = /^(skip|keep|same|no change)$/i;

export const isCancel = (input: string) => CANCEL.test(input.trim());
export const isYes = (input: string) => YES.test(input.trim());
const isSkip = (input: string) => SKIP.test(input.trim());

export const COMMAND_EXAMPLES = [
  "rename this set to Week 2",
  "add a question",
  "update question 2",
  "remove question 3",
  "shuffle the questions",
  "shuffle the choices",
  "create a set called Practice",
  "generate 5 questions about loops (needs AI)",
];

export function helpMessage(aiEnabled: boolean): string {
  return (
    `I can edit this question set for you. Try: ${COMMAND_EXAMPLES.map((e) => `"${e}"`).join(", ")}.` +
    (aiEnabled
      ? " Anything else I will answer as a question."
      : " AI help is off, so I only understand these commands.")
  );
}

function say(state: Pending, ...messages: string[]): FlowResult {
  return { state, messages };
}

function shorten(text: string, max: number) {
  const value = text.trim() || "Untitled question";
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function label(index: number, question: CommandQuestion) {
  return `question ${index + 1} ("${shorten(question.text, 48)}")`;
}

function confirmState(effect: Effect, preview: string[], intro: string): FlowResult {
  return say({ kind: "confirm", effect, preview }, intro);
}

const CONFIRM_HINT = "Confirm to apply it, or cancel to leave things as they are.";

function optionPreview(options: string[], correctIndex: number | undefined) {
  return options.map(
    (text, i) => `${i + 1}. ${shorten(text, 64)}${i === correctIndex ? "  [correct]" : ""}`,
  );
}

function checkOptionCount(options: string[]): string | null {
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return `I need between ${MIN_OPTIONS} and ${MAX_OPTIONS} choices.`;
  }
  const unique = new Set(options.map((o) => o.trim().toLowerCase()));
  if (unique.size !== options.length) return "Each choice has to be different.";
  return null;
}

const isMultipleChoice = (q: CommandQuestion) => q.type === "mcq_single" || q.type === "mcq_multi";

// ----- targets ------------------------------------------------------------------------------

type Resolved = { status: "match"; target: TextTarget } | { status: "reply"; result: FlowResult };

function resolveTarget(
  ctx: FlowContext,
  reference: QuestionTargetReference | undefined,
  action: "remove" | "update",
  changes: UpdateChanges,
): Resolved {
  const total = ctx.questions.length;
  if (total === 0) {
    return { status: "reply", result: say(START, "This set has no questions yet.") };
  }
  const resolution = resolveQuestionTarget({ questions: ctx.questions }, reference);
  if (resolution.status === "match") {
    const { question, index } = resolution.target;
    return {
      status: "match",
      target: { question: ctx.questions.find((q) => q.id === question.id)!, index },
    };
  }
  const ask = (candidates?: number[]) => ({
    kind: "ask_target" as const,
    action,
    changes,
    candidates,
  });
  if (resolution.status === "ambiguous") {
    const lines = resolution.candidates.map(({ question, index }: ResolvedQuestionTarget) =>
      summarizeQuestion(question, index),
    );
    return {
      status: "reply",
      result: say(
        ask(resolution.candidates.map((c: ResolvedQuestionTarget) => c.index)),
        "More than one question matches. Reply with the number of the one you mean:",
        ...lines,
      ),
    };
  }
  const outOfRange =
    reference?.type === "ordinal" && typeof reference.value === "number"
      ? ` There is no question ${reference.value}; this set has ${total} ${total === 1 ? "question" : "questions"}.`
      : "";
  return {
    status: "reply",
    result: say(
      ask(),
      `I could not tell which question you mean.${outOfRange} Say its number, "first", "last", or part of its text.`,
    ),
  };
}

function targetFromAnswer(input: string): QuestionTargetReference | undefined {
  return parseEditorIntent(`update question ${input}`).target;
}

// ----- starting each command ----------------------------------------------------------------

function startRemove(ctx: FlowContext, target: TextTarget): FlowResult {
  const { question, index } = target;
  return confirmState(
    { type: "delete_question", questionId: question.id, label: label(index, question) },
    [summarizeQuestion(question, index)],
    `I will remove ${label(index, question)}. ${CONFIRM_HINT}`,
  );
}

function updatePatch(
  target: TextTarget,
  changes: UpdateChanges,
):
  | { patch: Extract<Effect, { type: "update_question" }>["patch"]; preview: string[] }
  | "need_correct"
  | string {
  const { question } = target;
  const patch: Extract<Effect, { type: "update_question" }>["patch"] = {};
  const preview: string[] = [];

  if (changes.text !== undefined) {
    patch.prompt = changes.text;
    preview.push(`Question: ${shorten(changes.text, 120)}`);
  }

  let optionTexts = question.options.map((o) => o.text);
  let correctIndex = question.options.findIndex((o) => o.correct);
  let optionsChanged = false;

  if (changes.options) {
    const problem = checkOptionCount(changes.options);
    if (problem) return problem;
    optionsChanged = true;
    optionTexts = changes.options;
    // Keep the current answer if its wording survives in the new list.
    const wanted = question.options
      .find((o) => o.correct)
      ?.text.trim()
      .toLowerCase();
    correctIndex = optionTexts.findIndex((t) => t.trim().toLowerCase() === wanted);
  }

  if (changes.correct !== undefined) {
    const found = parseCorrectAnswer(String(changes.correct), optionTexts);
    if (found === null) return "no_match";
    correctIndex = found;
  }

  if (optionsChanged && correctIndex < 0) return "need_correct";

  if (optionsChanged || changes.correct !== undefined) {
    const ids = optionsChanged
      ? optionTexts.map((text, i) => ({ id: OPTION_IDS[i]!, text }))
      : question.options.map((o) => ({ id: o.id, text: o.text }));
    if (optionsChanged) patch.options = ids;
    patch.correctOptionIds = [ids[correctIndex]!.id];
    preview.push(...optionPreview(optionTexts, correctIndex));
  }

  if (Object.keys(patch).length === 0) return "nothing";
  return { patch, preview };
}

function finishUpdate(target: TextTarget, changes: UpdateChanges): FlowResult {
  const built = updatePatch(target, changes);
  const { question, index } = target;
  if (built === "need_correct") {
    return say(
      { kind: "update_correct", target, changes },
      "Which option should be correct after this update? Reply with the choice number or the exact text.",
    );
  }
  if (built === "no_match") {
    return say(
      { kind: "update_correct", target, changes: { ...changes, correct: undefined } },
      "I could not match that answer. Reply with the choice number or the exact option text.",
    );
  }
  if (built === "nothing") {
    return say(START, `Nothing to change on ${label(index, question)}.`);
  }
  if (typeof built === "string") {
    return say(
      { kind: "update_options", target, changes: { ...changes, options: undefined } },
      `${built} Send the full list again, or type skip.`,
    );
  }
  const multi =
    question.type === "mcq_multi" && built.patch.correctOptionIds
      ? " This is a multiple-answer question: only the option you chose will stay correct."
      : "";
  return confirmState(
    {
      type: "update_question",
      questionId: question.id,
      label: label(index, question),
      patch: built.patch,
    },
    built.preview,
    `I prepared the update for ${label(index, question)}.${multi} It is saved as a new revision. ${CONFIRM_HINT}`,
  );
}

function startUpdate(target: TextTarget, changes: UpdateChanges): FlowResult {
  const { question, index } = target;
  if (!isMultipleChoice(question)) {
    return say(
      START,
      `${label(index, question)} is not a multiple-choice question. Use its Edit button to change it.`,
    );
  }
  const hasChanges =
    changes.text !== undefined || changes.options !== undefined || changes.correct !== undefined;
  if (hasChanges) return finishUpdate(target, changes);
  return say(
    { kind: "update_text", target, changes },
    `What should ${label(index, question)} say now? Send the new question text, or type skip to keep it.`,
  );
}

function startGenerate(
  ctx: FlowContext,
  count: number | undefined,
  topic: string | undefined,
): FlowResult {
  if (!ctx.aiEnabled) {
    return say(
      START,
      'Generating questions needs AI, which is turned off on this server. You can still add questions yourself: say "add a question".',
    );
  }
  const valid = count !== undefined && Number.isInteger(count) && count >= 1 && count <= 10;
  if (count !== undefined && !valid) {
    return say(
      { kind: "ask_generate", count: undefined, topic },
      "Tell me how many questions to write, a number from 1 to 10.",
    );
  }
  if (!valid) {
    return say(
      { kind: "ask_generate", count: undefined, topic },
      topic
        ? `How many questions about ${topic}? (1 to 10)`
        : "How many questions should I write, and on what topic? For example: 5 about loops.",
    );
  }
  return {
    state: START,
    messages: [
      `Writing ${count} ${count === 1 ? "question" : "questions"}${topic ? ` about ${topic}` : ""}…`,
    ],
    run: { type: "generate", count, topic },
  };
}

function dispatch(intent: ParsedEditorIntent, ctx: FlowContext): FlowResult {
  switch (intent.kind) {
    case "rename_set": {
      const title = intent.title?.trim();
      if (title) {
        return confirmState(
          { type: "rename_set", title },
          [`New name: ${title}`],
          `I will rename this set to "${title}". ${CONFIRM_HINT}`,
        );
      }
      if (ctx.aiEnabled) {
        if (ctx.questions.length === 0) {
          return say(
            START,
            'Add some questions first so I can suggest a name, or tell me the name: "rename this set to ...".',
          );
        }
        return { state: START, messages: ["Thinking of a name…"], run: { type: "suggest_title" } };
      }
      return say({ kind: "ask_rename_title" }, "What should this set be called?");
    }
    case "create_set": {
      const title = intent.title?.trim();
      if (title) {
        return confirmState(
          { type: "create_set", title },
          [`New set: ${title}`],
          `I will create a new question set called "${title}" in this course and open it. ${CONFIRM_HINT}`,
        );
      }
      return say({ kind: "ask_create_title" }, "What should the new question set be called?");
    }
    case "generate_questions":
      return startGenerate(ctx, intent.count, intent.topic);
    case "add_question":
      if (intent.questionText) {
        return say({ kind: "add_options", text: intent.questionText }, optionsPrompt());
      }
      return say({ kind: "add_text" }, "What should the new question ask?");
    case "remove_question": {
      const resolved = resolveTarget(ctx, intent.target, "remove", {});
      return resolved.status === "match" ? startRemove(ctx, resolved.target) : resolved.result;
    }
    case "update_question": {
      const changes: UpdateChanges = {
        text: intent.changes?.questionText,
        options: intent.changes?.options,
        correct: intent.changes?.correctAnswer,
      };
      const resolved = resolveTarget(ctx, intent.target, "update", changes);
      return resolved.status === "match" ? startUpdate(resolved.target, changes) : resolved.result;
    }
    case "randomize_question":
      return say(
        START,
        'Rewriting a question with AI is not available yet. To change one yourself, say "update question 2" or use its Edit button.',
      );
    case "shuffle_questions": {
      if (ctx.questions.length < 2)
        return say(START, "You need at least two questions before I can shuffle them.");
      const proposal = buildShuffledQuestionOrder({ questions: ctx.questions });
      return confirmState(
        { type: "reorder", questionIds: proposal.questionIds },
        proposal.summary,
        `I prepared a new question order. ${CONFIRM_HINT}`,
      );
    }
    case "shuffle_choices": {
      const targets = ctx.questions.filter(isMultipleChoice);
      if (targets.length === 0)
        return say(START, "This set has no multiple-choice questions to shuffle.");
      return confirmState(
        { type: "shuffle_choices", questionIds: targets.map((q) => q.id) },
        [`${targets.length} multiple-choice ${targets.length === 1 ? "question" : "questions"}`],
        `I will shuffle the choices of ${targets.length} multiple-choice ${targets.length === 1 ? "question" : "questions"}. Each is saved as a new revision and the correct answers stay correct. ${CONFIRM_HINT}`,
      );
    }
    case "chat":
    default:
      return ctx.aiEnabled
        ? { state: START, messages: [], passToAi: true }
        : say(START, helpMessage(false));
  }
}

function optionsPrompt() {
  return `Now send the answer choices, one per line or separated with |. I need ${MIN_OPTIONS} to ${MAX_OPTIONS} different choices.`;
}

// ----- answering a question the assistant asked --------------------------------------------

function answer(
  state: Exclude<Pending, { kind: "none" } | { kind: "confirm" }>,
  input: string,
  ctx: FlowContext,
): FlowResult {
  const text = input.trim();
  switch (state.kind) {
    case "ask_rename_title":
      return confirmState(
        { type: "rename_set", title: text },
        [`New name: ${text}`],
        `I will rename this set to "${text}". ${CONFIRM_HINT}`,
      );
    case "ask_create_title":
      return confirmState(
        { type: "create_set", title: text },
        [`New set: ${text}`],
        `I will create a new question set called "${text}" in this course and open it. ${CONFIRM_HINT}`,
      );
    case "ask_generate": {
      const merged = mergeQuestionGenerationRequest(
        { count: state.count, topic: state.topic },
        text,
      );
      return startGenerate(ctx, merged.count, merged.topic?.trim() || undefined);
    }
    case "add_text":
      return say({ kind: "add_options", text }, optionsPrompt());
    case "add_options": {
      const options = parseOptionList(text);
      const problem = checkOptionCount(options);
      if (problem)
        return say(state, `${problem} Send them again, one per line or separated with |.`);
      return say(
        { kind: "add_correct", text: state.text, options },
        "Which option is correct? Reply with the choice number or the exact text.",
      );
    }
    case "add_correct": {
      const correctIndex = parseCorrectAnswer(text, state.options);
      if (correctIndex === null) {
        return say(
          state,
          "I could not match that answer. Reply with the choice number or the exact option text.",
        );
      }
      return confirmState(
        { type: "add_question", prompt: state.text, options: state.options, correctIndex },
        [`Question: ${shorten(state.text, 120)}`, ...optionPreview(state.options, correctIndex)],
        `I have the new question ready. ${CONFIRM_HINT}`,
      );
    }
    case "ask_target": {
      if (state.candidates && /^\d+$/.test(text)) {
        const index = Number(text) - 1;
        if (state.candidates.includes(index)) {
          const question = ctx.questions[index];
          if (question) {
            const target = { question, index };
            return state.action === "remove"
              ? startRemove(ctx, target)
              : startUpdate(target, state.changes);
          }
        }
        return say(
          state,
          "That is not one of the matching questions. Reply with one of the numbers above, or cancel.",
        );
      }
      const resolved = resolveTarget(ctx, targetFromAnswer(text), state.action, state.changes);
      if (resolved.status === "reply") return resolved.result;
      return state.action === "remove"
        ? startRemove(ctx, resolved.target)
        : startUpdate(resolved.target, state.changes);
    }
    case "update_text": {
      const changes = { ...state.changes, text: isSkip(text) ? undefined : text };
      return say(
        { kind: "update_options", target: state.target, changes },
        "Send the full list of choices next (one per line or separated with |), or type skip to keep the current choices.",
      );
    }
    case "update_options": {
      if (isSkip(text)) {
        const changes = { ...state.changes, options: undefined };
        return say(
          { kind: "update_correct", target: state.target, changes },
          "Which option should be correct? Reply with the choice number or the exact text, or type skip to keep the current answer.",
        );
      }
      const options = parseOptionList(text);
      const problem = checkOptionCount(options);
      if (problem) return say(state, `${problem} Send the full list again, or type skip.`);
      return finishUpdate(state.target, { ...state.changes, options });
    }
    case "update_correct": {
      if (isSkip(text)) return finishUpdate(state.target, { ...state.changes, correct: undefined });
      return finishUpdate(state.target, { ...state.changes, correct: text });
    }
  }
}

// ----- entry points --------------------------------------------------------------------------

/** Handles one message from the user in the current conversation state. */
export function step(state: Pending, input: string, ctx: FlowContext): FlowResult {
  const text = input.trim();
  if (!text) return say(state);

  if (state.kind === "none") return dispatch(parseEditorIntent(text), ctx);

  if (isCancel(text)) return say(START, "Okay, I left everything as it was.");

  if (state.kind === "confirm") {
    if (isYes(text)) return { state: START, messages: [], run: state.effect };
    // A new command replaces a pending preview rather than silently confirming it.
    const intent = parseEditorIntent(text);
    if (intent.kind !== "chat") {
      const next = dispatch(intent, ctx);
      return { ...next, messages: ["Okay, dropped the previous change.", ...next.messages] };
    }
    return say(state, "Please confirm to apply the change, or cancel.");
  }

  return answer(state, text, ctx);
}

/** The preview the user is asked to confirm, as lines of text. */
export function previewOf(state: Pending): string[] {
  return state.kind === "confirm" ? state.preview : [];
}

/** Reports what happened when the panel ran an action, and decides what comes next. */
export function afterEffect(effect: Effect, outcome: Outcome, ctx: FlowContext): FlowResult {
  if (!outcome.ok) return afterFailure(effect, outcome, ctx);
  switch (effect.type) {
    case "rename_set":
      return say(START, `Renamed the set to "${effect.title}".`);
    case "create_set":
      return say(START, `Created "${effect.title}". Opening it now.`);
    case "reorder":
      return say(START, "The questions are in their new order.");
    case "shuffle_choices": {
      const { done = 0, failed = 0 } = (outcome.data ?? {}) as { done?: number; failed?: number };
      return say(
        START,
        failed === 0
          ? `Shuffled the choices of ${done} ${done === 1 ? "question" : "questions"}.`
          : `Shuffled ${done} and could not shuffle ${failed}. Check the questions and try again.`,
      );
    }
    case "add_question":
      return say(START, "Added the question. It is saved as part of this set.");
    case "update_question":
      return say(START, `Updated ${effect.label}. The previous version stays in its history.`);
    case "delete_question":
      return say(START, `Removed ${effect.label}.`);
    case "exclude_question":
      return say(START, `Excluded ${effect.label} from practice. Its history is kept.`);
    case "suggest_title": {
      const title = String((outcome.data as { title?: string } | undefined)?.title ?? "").trim();
      if (!title) return say(START, "I could not come up with a name this time.");
      return confirmState(
        { type: "rename_set", title },
        [`New name: ${title}`],
        `I suggest renaming this set to "${title}" (AI-suggested). ${CONFIRM_HINT}`,
      );
    }
    case "generate": {
      const { proposed = 0, dropped = 0 } = (outcome.data ?? {}) as {
        proposed?: number;
        dropped?: number;
      };
      if (proposed === 0)
        return say(START, "No usable questions came back. Try again or change the topic.");
      return say(
        START,
        `I wrote ${proposed} ${proposed === 1 ? "question" : "questions"}${dropped > 0 ? ` (${dropped} failed checks and were left out)` : ""}. Review them below and save the ones you want as drafts.`,
      );
    }
  }
}

function afterFailure(
  effect: Effect,
  outcome: Extract<Outcome, { ok: false }>,
  ctx: FlowContext,
): FlowResult {
  if (effect.type === "delete_question" && outcome.code === "has_history") {
    return confirmState(
      { type: "exclude_question", questionId: effect.questionId, label: effect.label },
      [effect.label],
      `${capitalize(effect.label)} has study history, so it cannot be deleted. I can exclude it from practice instead and keep its history. ${CONFIRM_HINT}`,
    );
  }
  void ctx;
  return say(START, `That did not work: ${outcome.message}`);
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
