import "server-only";
import { asc, eq } from "drizzle-orm";
import {
  generatedQuestionsSchema,
  questionContentSchema,
  suggestedTitleSchema,
  type ChatRequest,
  type GenerateQuestionsRequest,
  type QuestionContent,
} from "@/lib/schemas";
import { assertOwnsCourse, assertOwnsQuestionSet } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { courses, questionRevisions, questions } from "@/server/db/schema";
import { AiInvalidOutput } from "./errors";
import type { AiProvider } from "./provider";
import { DATA_NOT_INSTRUCTIONS, delimitData, truncate } from "./prompt";

const OPTION_IDS = ["a", "b", "c", "d"] as const;

type SetContext = {
  title: string;
  course: { title: string; subject: string; language: string | null };
  prompts: string[];
};

/** Owner-checked context for a question set: its course and the existing question stems. */
export async function loadSetContext(
  db: Database,
  userId: string,
  setId: string,
): Promise<SetContext> {
  const set = await assertOwnsQuestionSet(db, userId, setId);
  const [course] = await db.select().from(courses).where(eq(courses.id, set.courseId));
  const rows = await db
    .select({ prompt: questionRevisions.prompt })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .where(eq(questions.questionSetId, setId))
    .orderBy(asc(questions.position))
    .limit(30);
  return {
    title: set.title,
    course: {
      title: course?.title ?? "",
      subject: course?.subject ?? "",
      language: course?.language ?? null,
    },
    prompts: rows.map((r) => truncate(r.prompt, 200)),
  };
}

function courseLine(course: SetContext["course"]) {
  return `Course: ${course.title} (${course.subject}${course.language ? `, language: ${course.language}` : ""}).`;
}

export async function chat(
  db: Database,
  provider: AiProvider,
  userId: string,
  input: ChatRequest,
): Promise<string> {
  let context = "";
  if (input.questionSetId) {
    const ctx = await loadSetContext(db, userId, input.questionSetId);
    context = `\n${courseLine(ctx.course)}\n${delimitData(
      "question set",
      `Title: ${ctx.title}\n${ctx.prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
    )}`;
  } else if (input.courseId) {
    const course = await assertOwnsCourse(db, userId, input.courseId);
    context = `\n${courseLine({ title: course.title, subject: course.subject, language: course.language })}`;
  }
  return provider.generateText([...input.history, { role: "user", content: input.message }], {
    system:
      "You are a friendly study assistant inside a quiz app. Answer in under 150 words." +
      ` ${DATA_NOT_INSTRUCTIONS}${context}`,
    maxOutputTokens: 512,
    temperature: 0.4,
  });
}

/** Returns validated proposals. Nothing is saved: the owner reviews them first. */
export async function generateQuestionProposals(
  db: Database,
  provider: AiProvider,
  userId: string,
  setId: string,
  input: GenerateQuestionsRequest,
): Promise<{ proposals: QuestionContent[]; dropped: number }> {
  const ctx = await loadSetContext(db, userId, setId);
  const parts = [
    `Write ${input.count} multiple-choice practice questions.`,
    input.topic ? delimitData("topic", input.topic, 400) : "",
    ctx.prompts.length
      ? `Do not repeat these existing questions:\n${delimitData("existing questions", ctx.prompts.join("\n"))}`
      : "",
  ].filter(Boolean);

  const generated = await provider.generateStructured(
    parts.join("\n\n"),
    generatedQuestionsSchema,
    {
      system:
        `You write multiple-choice questions for a student. ${courseLine(ctx.course)} ` +
        "Each question has exactly 4 options and exactly one correct option, with plausible wrong " +
        "options. Put any code inside the question text. Never use 'all of the above'. " +
        DATA_NOT_INSTRUCTIONS,
      maxOutputTokens: 4096,
      temperature: 0.7,
    },
  );

  const proposals: QuestionContent[] = [];
  for (const q of generated.questions) {
    const options = q.options.map((text, i) => ({ id: OPTION_IDS[i]!, text }));
    const parsed = questionContentSchema.safeParse({
      type: "mcq_single",
      prompt: q.prompt,
      options,
      correctOptionIds: [OPTION_IDS[q.correctIndex]!],
      explanation: q.explanation,
    });
    if (parsed.success) proposals.push(parsed.data);
  }
  if (proposals.length === 0) throw new AiInvalidOutput();
  return { proposals, dropped: generated.questions.length - proposals.length };
}

export async function suggestTitle(
  db: Database,
  provider: AiProvider,
  userId: string,
  setId: string,
): Promise<string> {
  const ctx = await loadSetContext(db, userId, setId);
  const result = await provider.generateStructured(
    `Suggest a title for this question set.\n${delimitData("questions", ctx.prompts.join("\n") || "(no questions yet)")}`,
    suggestedTitleSchema,
    {
      system:
        `Suggest a short, specific title (at most 8 words). ${courseLine(ctx.course)} ` +
        DATA_NOT_INSTRUCTIONS,
      maxOutputTokens: 100,
      temperature: 0.3,
    },
  );
  return result.title;
}
