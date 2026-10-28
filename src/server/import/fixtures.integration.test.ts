import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-fixtures-"));
process.env.STORAGE_DIR = storageDir;
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { POST as uploadPost } from "@/app/api/courses/[courseId]/imports/route";
import { GET as formatsGet } from "@/app/api/import/formats/route";
import { PATCH as itemPatch } from "@/app/api/imports/[importId]/items/[itemId]/route";
import { POST as publishPost } from "@/app/api/imports/[importId]/publish/route";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "@/server/content/courses";
import { getDb } from "@/server/db";
import { questionRevisions, questions } from "@/server/db/schema";
import { DEFAULT_LIMITS } from "@/server/extract/limits";
import { clearExtractors, runExtraction } from "@/server/extract/registry";
import { clearDetectors, detectorFor } from "./detectors";
import { buildDraftItems } from "./drafts";
import { ensureImportersRegistered } from "./setup";

const FIXTURE_DIR = path.join(process.cwd(), "fixtures/docx");

// What each A7 fixture should produce through the whole pipeline.
const EXPECTED: Record<
  string,
  { items: { type: string; correct: string[]; warnings: string[] }[]; draftWarnings: string[] }
> = {
  "bullet-only.docx": {
    items: [{ type: "mcq_single", correct: ["a"], warnings: [] }],
    draftWarnings: [],
  },
  "edge-cases.docx": {
    items: [],
    draftWarnings: ["option_without_question", "question_skipped", "no_questions_found"],
  },
  // The picture is kept, so the "image not imported" warning is gone. It has no description yet.
  "image-in-question.docx": {
    items: [{ type: "mcq_single", correct: ["a"], warnings: ["image_alt_missing"] }],
    draftWarnings: [],
  },
  "image-reused.docx": {
    items: [
      { type: "mcq_single", correct: ["a"], warnings: [] },
      { type: "mcq_single", correct: ["b"], warnings: [] },
    ],
    draftWarnings: [],
  },
  "image-with-alt.docx": {
    items: [{ type: "mcq_single", correct: ["a"], warnings: [] }],
    draftWarnings: [],
  },
  "inherited-bold.docx": {
    items: [{ type: "mcq_single", correct: ["b"], warnings: [] }],
    draftWarnings: [],
  },
  "manual-numbering.docx": {
    items: [
      { type: "mcq_single", correct: ["b"], warnings: [] },
      { type: "mcq_single", correct: ["b"], warnings: [] },
    ],
    draftWarnings: [],
  },
  "missing-bold.docx": {
    items: [{ type: "mcq_single", correct: [], warnings: ["no_bold_answer", "answer_unresolved"] }],
    draftWarnings: [],
  },
  "multiple-bold.docx": {
    items: [{ type: "mcq_multi", correct: ["a", "b"], warnings: ["multiple_bold_answers"] }],
    draftWarnings: [],
  },
  "numbered-list.docx": {
    items: [
      { type: "mcq_single", correct: ["b"], warnings: [] },
      { type: "mcq_single", correct: ["a"], warnings: [] },
    ],
    draftWarnings: [],
  },
  "partial-bold.docx": {
    items: [{ type: "mcq_single", correct: [], warnings: ["partial_bold", "answer_unresolved"] }],
    draftWarnings: [],
  },
  "typed-numbers.docx": {
    items: [
      { type: "mcq_single", correct: ["b"], warnings: [] },
      { type: "mcq_single", correct: ["a"], warnings: [] },
      { type: "mcq_single", correct: ["b"], warnings: [] },
      { type: "mcq_single", correct: ["b"], warnings: [] },
    ],
    draftWarnings: [],
  },
  "wrapped-option.docx": {
    items: [{ type: "mcq_single", correct: ["b"], warnings: [] }],
    draftWarnings: [],
  },
};

const db = getDb();
let alice: TestUser;
let courseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
});

beforeEach(async () => {
  clearExtractors();
  clearDetectors();
  const course = await createCourse(db, alice.id, { title: `C ${Math.random()}`, subject: "CS" });
  courseId = course.id;
});

afterAll(async () => {
  await deleteUsers(db, [alice.id]);
  await rm(storageDir, { recursive: true, force: true });
});

async function uploadFixture(name: string) {
  const bytes = await readFile(path.join(FIXTURE_DIR, name));
  const form = new FormData();
  form.set("file", new File([bytes], name));
  const response = await uploadPost(
    new Request("http://localhost:3000/x", {
      method: "POST",
      headers: { cookie: alice.cookie, origin: "http://localhost:3000" },
      body: form,
    }),
    { params: Promise.resolve({ courseId }) },
  );
  return { status: response.status, body: await response.json(), bytes };
}

async function json(
  handler: unknown,
  body: unknown,
  params: Record<string, string>,
  method = "POST",
) {
  const response = await (
    handler as (r: Request, c: { params: Promise<never> }) => Promise<Response>
  )(authRequest("/x", { method, body, cookie: alice.cookie }), {
    params: Promise.resolve(params as never),
  });
  return { status: response.status, body: await response.json() };
}

describe("A7 fixtures through the import pipeline", () => {
  it("covers every fixture file", async () => {
    const files = (await readdir(FIXTURE_DIR)).filter((n) => n.endsWith(".docx")).sort();
    expect(files).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("%s yields the expected draft", async (name, expected) => {
    const { status, body, bytes } = await uploadFixture(name);
    expect(status).toBe(201);
    const draft = body.import;

    expect(
      draft.items.map(
        (i: {
          payload: { type: string; correctOptionIds: string[] };
          warnings: { code: string }[];
        }) => ({
          type: i.payload.type,
          correct: i.payload.correctOptionIds,
          warnings: i.warnings.map((w) => w.code),
        }),
      ),
    ).toEqual(expected.items);
    expect(draft.warnings.map((w: { code: string }) => w.code)).toEqual(expected.draftWarnings);

    // Items and warnings match what the extractor and detector produce directly.
    const file = { filename: name, mimeType: "" };
    const extracted = await runExtraction(bytes, file, DEFAULT_LIMITS);
    const detected = detectorFor("docx")!(extracted);
    const direct = buildDraftItems(extracted, detected.questions);
    // Stored images are added during the import, so compare everything but the image reference.
    const withoutImage = (payload: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "image"));
    expect(
      draft.items.map((i: { payload: Record<string, unknown> }) => withoutImage(i.payload)),
    ).toEqual(direct.items.map((i) => withoutImage(i.payload as Record<string, unknown>)));
    expect(draft.items.length).toBe(direct.items.length);
  });

  it("publishes original wording and keeps unresolved answers out of play", async () => {
    const { body } = await uploadFixture("missing-bold.docx");
    const draft = body.import;
    const item = draft.items[0];
    const patched = await json(
      itemPatch,
      { decision: "accepted" },
      { importId: draft.id, itemId: item.id },
      "PATCH",
    );
    expect(patched.status).toBe(200);

    const published = await json(publishPost, { title: "Fixture" }, { importId: draft.id });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ published: 1, unresolved: 1 });

    const rows = await db
      .select({ q: questions, r: questionRevisions })
      .from(questions)
      .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
      .where(eq(questions.questionSetId, published.body.questionSetId));
    expect(rows[0]?.r.prompt).toBe(item.payload.prompt);
    expect(rows[0]?.r.options.map((o) => o.text)).toEqual(
      item.payload.options.map((o: { text: string }) => o.text),
    );
    expect(rows[0]?.r.answerKey).toEqual({ kind: "unresolved" });
    expect(rows[0]?.q.status).toBe("excluded");
  });

  it("removes typed question numbers on import, remembers the originals, and keeps numeric content", async () => {
    const { status, body } = await uploadFixture("typed-numbers.docx");
    expect(status).toBe(201);
    const prompts = body.import.items.map(
      (i: { payload: { prompt: string; originalPrompt?: string } }) => [
        i.payload.prompt,
        i.payload.originalPrompt ?? null,
      ],
    );
    expect(prompts).toEqual([
      ["What does len([1, 2]) return?", "1. What does len([1, 2]) return?"],
      [
        "Which keyword defines a function in Python?",
        "Question 2: Which keyword defines a function in Python?",
      ],
      ["Which loop always runs at least once?", "3. Which loop always runs at least once?"],
      ["2 + 2 = ?", null],
    ]);
  });

  it("reports DOCX as the only supported format", async () => {
    ensureImportersRegistered();
    const response = await formatsGet(authRequest("/x", { cookie: alice.cookie }));
    expect((await response.json()).formats).toEqual([{ extension: "docx", label: "Word (.docx)" }]);
  });
});
