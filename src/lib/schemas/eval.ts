import { z } from "zod";
import { answerKeySchema } from "./answer-key";
import { optionSchema } from "./options";
import { responseSchema } from "./response";

/**
 * One line of an evaluation file (`evals/<language>/<task>.jsonl`). Cases are written and
 * checked by a person: `review` says who and why, and the loader refuses a line without it. A
 * model must never be the only reviewer of a case it will later be scored on.
 */

export const EVAL_TASKS = [
  "hint",
  "explanation",
  "question_generation",
  "short_answer_grading",
] as const;
export type EvalTask = (typeof EVAL_TASKS)[number];

export const EVAL_TAGS = [
  "missing_source",
  "misleading_key",
  "ambiguous",
  "prompt_injection",
  "alternative_valid_answer",
  "subject_edge_case",
  "retry_protected",
] as const;
export type EvalTag = (typeof EVAL_TAGS)[number];

const localId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "use lowercase letters, digits, . _ -");
const text = (max: number) => z.string().trim().min(1).max(max);

const question = z
  .object({
    type: z.enum(["mcq_single", "mcq_multi", "short_answer", "fill_blank", "output_prediction"]),
    prompt: text(10_000),
    codeSnippet: z.string().max(20_000).nullish(),
    options: z.array(optionSchema).max(10).default([]),
    answerKey: answerKeySchema,
    explanation: z.string().max(10_000).nullish(),
  })
  .strict();

/** A passage handed to the model. Ids are local to the case; the runner maps them to UUIDs. */
const passage = z
  .object({
    id: localId,
    filename: text(200),
    location: text(200),
    text: text(6_000),
  })
  .strict();

const stringList = (max = 20) => z.array(text(500)).max(max);

const tutorInput = (actions: [string, ...string[]]) =>
  z
    .object({
      question,
      action: z.enum(actions),
      passages: z.array(passage).max(5).default([]),
      /** The student's earlier wrong answer, for "why was I wrong". */
      priorWrong: responseSchema.optional(),
      /** The retry that follows a wrong first answer: its correct answer is still hidden. */
      protectedRetry: z.boolean().default(false),
    })
    .strict();

const tutorExpected = z
  .object({
    /** Words that must not appear in help that has to stop short of the answer. */
    forbiddenAnswerStrings: stringList().default([]),
    /** Any one of these appearing in an explanation counts as stating the right answer. */
    acceptedAnswerStrings: stringList().default([]),
    /** Passages the help should cite when it cites anything. */
    requiredCitationIds: z.array(localId).max(5).default([]),
    /** The honest reply is to say it is unsure or that no passage supports it. */
    abstain: z.boolean().default(false),
    /** What a person checks that a script cannot: steps, reasoning, tone. */
    rubric: stringList(10).min(1),
  })
  .strict();

const generationInput = z
  .object({
    course: z
      .object({ title: text(200), subject: text(200), language: z.string().max(40).nullable() })
      .strict(),
    existingPrompts: z.array(text(300)).max(30).default([]),
    count: z.number().int().min(1).max(5),
    topic: z.string().trim().max(400).optional(),
  })
  .strict();

const generationExpected = z
  .object({
    /** Text that must not appear in any generated question (for example an injected instruction). */
    forbiddenStrings: stringList().default([]),
    rubric: stringList(10).min(1),
  })
  .strict();

const gradingInput = z
  .object({
    question: question.refine(
      (q) => ["short_answer", "fill_blank", "output_prediction"].includes(q.type),
      {
        message: "grading cases use a short-answer, fill-in or output question",
      },
    ),
    response: responseSchema,
  })
  .strict();

const gradingExpected = z
  .object({
    outcome: z.enum(["correct", "incorrect", "uncertain"]),
    why: text(500),
  })
  .strict();

const base = {
  id: localId,
  language: z.string().regex(/^[a-z0-9_+-]{1,30}$/),
  allowedCitationIds: z.array(localId).max(5).default([]),
  tags: z.array(z.enum(EVAL_TAGS)).max(EVAL_TAGS.length).default([]),
  review: z
    .object({
      checkedBy: text(100),
      checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
      rationale: z.string().trim().min(10).max(1_000),
    })
    .strict(),
  /** Where the content came from and its version, so a change in the source is noticed. */
  sourceVersion: text(100),
  /** `smoke` cases only test the harness. They are never quality evidence and never sent live. */
  kind: z.enum(["checked", "smoke"]).default("checked"),
};

export const evalCaseSchema = z
  .discriminatedUnion("task", [
    z.object({
      ...base,
      task: z.literal("hint"),
      input: tutorInput(["small_hint", "why_wrong"]),
      expected: tutorExpected,
    }),
    z.object({
      ...base,
      task: z.literal("explanation"),
      input: tutorInput(["explain_step", "similar_example", "full_explanation"]),
      expected: tutorExpected,
    }),
    z.object({
      ...base,
      task: z.literal("question_generation"),
      input: generationInput,
      expected: generationExpected,
    }),
    z.object({
      ...base,
      task: z.literal("short_answer_grading"),
      input: gradingInput,
      expected: gradingExpected,
    }),
  ])
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const passageIds =
      value.task === "hint" || value.task === "explanation"
        ? value.input.passages.map((p) => p.id)
        : [];
    if (new Set(passageIds).size !== passageIds.length) {
      issue(["input", "passages"], "passage ids must be unique");
    }
    if (new Set(value.allowedCitationIds).size !== value.allowedCitationIds.length) {
      issue(["allowedCitationIds"], "allowed citation ids must be unique");
    }
    for (const id of value.allowedCitationIds) {
      if (!passageIds.includes(id)) {
        issue(["allowedCitationIds"], `"${id}" is not one of the case's passages`);
      }
    }
    if (value.task === "hint" || value.task === "explanation") {
      for (const id of value.expected.requiredCitationIds) {
        if (!value.allowedCitationIds.includes(id)) {
          issue(["expected", "requiredCitationIds"], `"${id}" is not an allowed citation`);
        }
      }
      if (value.tags.includes("missing_source") && value.allowedCitationIds.length > 0) {
        issue(["allowedCitationIds"], "a missing_source case has no legitimate citation");
      }
      const q = value.input.question;
      if ((q.type === "mcq_single" || q.type === "mcq_multi") && q.options.length < 2) {
        issue(["input", "question", "options"], "multiple-choice questions need options");
      }
      if (q.answerKey.kind === "unresolved") {
        issue(["input", "question", "answerKey"], "a case needs a resolved answer key");
      }
      if (value.task === "hint" && value.input.action === "small_hint") {
        const leaksNothing = value.expected.forbiddenAnswerStrings.length > 0;
        if (!leaksNothing && !value.tags.includes("ambiguous")) {
          issue(
            ["expected", "forbiddenAnswerStrings"],
            "a small-hint case lists the strings it must not state",
          );
        }
      }
      if (
        value.task === "explanation" &&
        value.expected.acceptedAnswerStrings.length === 0 &&
        !value.tags.includes("ambiguous")
      ) {
        issue(
          ["expected", "acceptedAnswerStrings"],
          "an explanation case lists the answer it should reach",
        );
      }
    } else if (value.allowedCitationIds.length > 0) {
      issue(["allowedCitationIds"], "this task cites no passages");
    }
  });

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalCaseOf<T extends EvalTask> = Extract<EvalCase, { task: T }>;
