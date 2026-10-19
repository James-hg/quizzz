import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-import-"));
process.env.STORAGE_DIR = storageDir;
process.env.MAX_UPLOAD_BYTES = "20000";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { POST as uploadPost } from "@/app/api/courses/[courseId]/imports/route";
import { GET as formatsGet } from "@/app/api/import/formats/route";
import { GET as importGet } from "@/app/api/imports/[importId]/route";
import { PATCH as itemPatch } from "@/app/api/imports/[importId]/items/[itemId]/route";
import { POST as publishPost } from "@/app/api/imports/[importId]/publish/route";
import { POST as restorePost } from "@/app/api/questions/[questionId]/restore/route";
import { PATCH as questionPatch } from "@/app/api/questions/[questionId]/route";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "@/server/content/courses";
import { listPlayableQuestionIds } from "@/server/content/questions";
import { createQuestionSet } from "@/server/content/question-sets";
import { getDb } from "@/server/db";
import {
  importDrafts,
  questionRevisions,
  questionSourceLinks,
  questionSets,
  questions,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { clearExtractors, registerExtractor } from "@/server/extract/registry";
import { Corrupt } from "@/server/extract/errors";
import type { Extractor, ExtractResult } from "@/server/extract/types";
import { clearDetectors, registerDetector } from "./detectors";
import type { DetectedQuestion, Detection } from "./types";
import { getStorage } from "@/server/storage";

// A stand-in format: the real DOCX extractor arrives in A7. Blocks are "Q: stem",
// "* correct option" and "- other option".
const SCRIPT = [
  "Intro heading",
  "Q: What does len([1, 2]) return?",
  "- 1",
  "* 2",
  "- 3",
  "Q: Which are mutable in Python?",
  "- list",
  "- tuple",
  "- dict",
  "Q: Pick the multi-answer",
  "* alpha",
  "* beta",
  "- gamma",
].join("\n");

function fakeExtract(bytes: Buffer): ExtractResult {
  const lines = (bytes.toString("latin1").match(/QUIZZZ:([^\0]*)/)?.[1] ?? SCRIPT).split("\n");
  return {
    blocks: lines.map((text, index) => ({
      id: `b${index}`,
      kind: index === 0 ? ("heading" as const) : ("paragraph" as const),
      text,
      anchor: { type: "docx_paragraph" as const, index, headingPath: [] },
    })),
    assets: [],
    warnings: [{ code: "demo_warning", message: "Demo extractor warning" }],
    meta: { format: "fake" },
  };
}

let failExtraction = false;
const fakeExtractor: Extractor = {
  name: "fake-docx",
  formats: [{ extension: "docx", label: "Word (.docx)" }],
  canHandle: (f) => f.filename.toLowerCase().endsWith(".docx"),
  extract: async (buffer) => {
    if (failExtraction) throw new Corrupt("The document could not be parsed.");
    return fakeExtract(buffer);
  },
};

function detect(result: ExtractResult): Detection {
  const found: DetectedQuestion[] = [];
  let current: DetectedQuestion | undefined;
  for (const block of result.blocks) {
    if (block.text.startsWith("Q: ")) {
      current = {
        prompt: block.text.slice(3),
        options: [],
        anchor: block.anchor,
        blockIds: [block.id],
        warnings: [],
      };
      found.push(current);
    } else if (current && /^[*-] /.test(block.text)) {
      current.options.push({ text: block.text.slice(2), isCorrect: block.text.startsWith("* ") });
      current.blockIds!.push(block.id);
    }
  }
  return { questions: found, warnings: [] };
}

function docxFile(script?: string) {
  const zip = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<d/>${script ? `QUIZZZ:${script}` : ""}`),
  });
  return new File([Buffer.from(zip)], "week1.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let courseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
});

beforeEach(async () => {
  clearExtractors();
  clearDetectors();
  registerExtractor(fakeExtractor);
  registerDetector("fake-docx", detect);
  failExtraction = false;
  const course = await createCourse(db, alice.id, {
    title: `Course ${Math.random()}`,
    subject: "Intro",
    language: "python",
  });
  courseId = course.id;
});

afterEach(clearExtractors);

afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
  await rm(storageDir, { recursive: true, force: true });
});

async function upload(file: File, options: { as?: TestUser; course?: string } = {}) {
  const who = options.as ?? alice;
  const form = new FormData();
  form.set("file", file);
  const request = new Request("http://localhost:3000/api/x", {
    method: "POST",
    headers: { cookie: who.cookie, origin: "http://localhost:3000" },
    body: form,
  });
  const response = await uploadPost(request, {
    params: Promise.resolve({ courseId: options.course ?? courseId }),
  });
  return { status: response.status, body: await response.json() };
}

async function call(
  handler: unknown,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    as?: TestUser | null;
    params: Record<string, string>;
  },
) {
  const who = options.as === undefined ? alice : options.as;
  const request = authRequest(path, {
    method: options.method,
    body: options.body,
    cookie: who?.cookie,
  });
  const response = await (
    handler as (r: Request, c: { params: Promise<never> }) => Promise<Response>
  )(request, { params: Promise.resolve(options.params as never) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const getDraft = (id: string, as?: TestUser) =>
  call(importGet, "/x", { params: { importId: id }, as });
const patchItem = (id: string, itemId: string, body: unknown, as?: TestUser) =>
  call(itemPatch, "/x", { method: "PATCH", body, params: { importId: id, itemId }, as });
const publish = (id: string, body: unknown, as?: TestUser) =>
  call(publishPost, "/x", { method: "POST", body, params: { importId: id }, as });

describe("upload", () => {
  it("creates a draft whose items and warnings match the extractor output", async () => {
    const { status, body } = await upload(docxFile());
    expect(status).toBe(201);
    const draft = body.import;
    expect(draft.status).toBe("extracted");
    expect(draft.source.filename).toBe("week1.docx");
    expect(draft.warnings.map((w: { code: string }) => w.code)).toEqual(["demo_warning"]);
    expect(draft.items).toHaveLength(3);

    const [one, two, three] = draft.items;
    expect(one.payload).toMatchObject({
      type: "mcq_single",
      prompt: "What does len([1, 2]) return?",
      correctOptionIds: ["b"],
    });
    expect(one.warnings).toEqual([]);
    expect(two.payload.correctOptionIds).toEqual([]);
    expect(two.warnings.map((w: { code: string }) => w.code)).toContain("answer_unresolved");
    expect(three.payload).toMatchObject({ type: "mcq_multi", correctOptionIds: ["a", "b"] });
    // The preview shows the source text each item came from.
    expect(one.sources.map((s: { text: string }) => s.text)).toContain("* 2");
  });

  it("stores the file privately and its segments", async () => {
    const { body } = await upload(docxFile());
    const [doc] = await db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, body.import.source.id));
    expect(doc?.extractionStatus).toBe("extracted");
    expect(doc?.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    expect(await getStorage().exists(doc!.storageKey)).toBe(true);
    const segments = await db
      .select()
      .from(sourceSegments)
      .where(eq(sourceSegments.sourceDocumentId, doc!.id));
    expect(segments).toHaveLength(13);
  });

  it("rejects unsupported types with 415 and the supported-format list", async () => {
    const { status, body } = await upload(new File([Buffer.from("MZ....")], "malware.exe"));
    expect(status).toBe(415);
    expect(body.error.code).toBe("unsupported_format");
    expect(body.error.details.supportedFormats).toEqual([
      { extension: "docx", label: "Word (.docx)" },
    ]);
    expect(body.error.message).toContain("Word (.docx)");
    const stored = await db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.courseId, courseId));
    expect(stored).toHaveLength(0);
  });

  it("rejects a .docx that is not a ZIP as corrupt without storing it", async () => {
    const { status, body } = await upload(new File([Buffer.from("plain text")], "fake.docx"));
    expect(status).toBe(422);
    expect(body.error.code).toBe("corrupt");
    expect(
      await db.select().from(sourceDocuments).where(eq(sourceDocuments.courseId, courseId)),
    ).toHaveLength(0);
  });

  it("rejects oversize uploads with 413", async () => {
    const big = new File([Buffer.alloc(30_000, 1)], "big.docx");
    const { status, body } = await upload(big);
    expect(status).toBe(413);
    expect(body.error.code).toBe("too_large");
  });

  it("keeps the source document and a readable error when parsing fails", async () => {
    failExtraction = true;
    const { status, body } = await upload(docxFile());
    expect(status).toBe(422);
    expect(body.error.message).toBe("The document could not be parsed.");
    const importId = body.error.details.importId as string;

    const failed = await getDraft(importId);
    expect(failed.body.import.status).toBe("failed");
    expect(failed.body.import.errorMessage).toBe("The document could not be parsed.");
    expect(failed.body.import.source.extractionStatus).toBe("failed");
    expect(failed.body.import.items).toEqual([]);
    expect((await patchItem(importId, crypto.randomUUID(), { decision: "accepted" })).status).toBe(
      409,
    );
    expect((await publish(importId, { title: "x" })).status).toBe(409);
  });

  it("lists the supported formats and size limit", async () => {
    const { status, body } = await call(formatsGet, "/x", { params: {} });
    expect(status).toBe(200);
    expect(body.formats).toEqual([{ extension: "docx", label: "Word (.docx)" }]);
    expect(body.maxUploadBytes).toBe(20000);
    expect((await call(formatsGet, "/x", { params: {}, as: null })).status).toBe(401);
  });
});

describe("review and publish", () => {
  async function reviewed() {
    const { body } = await upload(docxFile());
    const draft = body.import;
    const [one, two, three] = draft.items;
    await patchItem(draft.id, one.id, { decision: "accepted" });
    await patchItem(draft.id, two.id, { decision: "accepted" });
    await patchItem(draft.id, three.id, { decision: "excluded" });
    return { draft, one, two, three };
  }

  it("edits an item, clears the unresolved warning, and moves to reviewing", async () => {
    const { body } = await upload(docxFile());
    const draft = body.import;
    const unresolved = draft.items[1];
    const edited = await patchItem(draft.id, unresolved.id, {
      edit: { correctOptionIds: ["c"], prompt: "Which are mutable?" },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.import.status).toBe("reviewing");
    const item = edited.body.import.items[1];
    expect(item.decision).toBe("edited");
    expect(item.payload.prompt).toBe("Which are mutable?");
    expect(item.payload.correctOptionIds).toEqual(["c"]);
    expect(item.warnings.map((w: { code: string }) => w.code)).not.toContain("answer_unresolved");
  });

  it("rejects an invalid edit with 400", async () => {
    const { body } = await upload(docxFile());
    const bad = await patchItem(body.import.id, body.import.items[0].id, {
      edit: { correctOptionIds: ["zzz"] },
    });
    expect(bad.status).toBe(400);
    const tooMany = await patchItem(body.import.id, body.import.items[0].id, {
      edit: { correctOptionIds: ["a", "b"] },
    });
    expect(tooMany.status).toBe(400);
  });

  it("publishes accepted items with original wording and source links", async () => {
    const { draft } = await reviewed();
    const result = await publish(draft.id, { title: "Week 1 import" });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ published: 2, unresolved: 1, alreadyPublished: false });

    const [set] = await db
      .select()
      .from(questionSets)
      .where(eq(questionSets.id, result.body.questionSetId));
    expect(set).toMatchObject({ origin: "imported", title: "Week 1 import", courseId });

    const rows = await db
      .select({ q: questions, r: questionRevisions })
      .from(questions)
      .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
      .where(eq(questions.questionSetId, set!.id))
      .orderBy(questions.position);
    expect(rows).toHaveLength(2);

    const resolved = rows[0]!;
    expect(resolved.r.prompt).toBe("What does len([1, 2]) return?");
    expect(resolved.r.options.map((o) => o.text)).toEqual(["1", "2", "3"]);
    expect(resolved.r.answerKey).toEqual({ kind: "options", correctOptionIds: ["b"] });
    expect(resolved.r.origin).toBe("original");
    expect(resolved.r.evidenceStatus).toBe("human_reviewed");
    expect(resolved.q.status).toBe("active");

    const unresolved = rows[1]!;
    expect(unresolved.r.answerKey).toEqual({ kind: "unresolved" });
    expect(unresolved.r.evidenceStatus).toBe("unresolved");
    expect(unresolved.q.status).toBe("excluded");

    // Not playable as a scored item until an answer is set.
    expect(await listPlayableQuestionIds(db, set!.id)).toEqual([resolved.q.id]);

    const links = await db
      .select()
      .from(questionSourceLinks)
      .where(eq(questionSourceLinks.questionRevisionId, resolved.r.id));
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.relationship === "origin")).toBe(true);
  });

  it("is idempotent: publishing twice creates one question set", async () => {
    const { draft } = await reviewed();
    const first = await publish(draft.id, { title: "Once" });
    const second = await publish(draft.id, { title: "Twice" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      questionSetId: first.body.questionSetId,
      alreadyPublished: true,
    });
    const sets = await db.select().from(questionSets).where(eq(questionSets.courseId, courseId));
    expect(sets).toHaveLength(1);
    const [stored] = await db.select().from(importDrafts).where(eq(importDrafts.id, draft.id));
    expect(stored?.status).toBe("published");
    expect((await patchItem(draft.id, draft.items[0].id, { decision: "excluded" })).status).toBe(
      409,
    );
  });

  it("refuses to publish when nothing is accepted", async () => {
    const { body } = await upload(docxFile());
    const result = await publish(body.import.id, { title: "Empty" });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("nothing_to_publish");
  });

  it("publishes into an existing set in the same course only", async () => {
    const { draft } = await reviewed();
    const other = await createCourse(db, alice.id, { title: "Other", subject: "x" });
    const wrongSet = await createQuestionSet(db, alice.id, other.id, "Elsewhere");
    expect((await publish(draft.id, { questionSetId: wrongSet.id })).status).toBe(400);
    const rightSet = await createQuestionSet(db, alice.id, courseId, "Here");
    const ok = await publish(draft.id, { questionSetId: rightSet.id });
    expect(ok.status).toBe(201);
    expect(ok.body.questionSetId).toBe(rightSet.id);
  });

  it("requires exactly one of title or questionSetId", async () => {
    const { draft } = await reviewed();
    expect((await publish(draft.id, {})).status).toBe(400);
    expect(
      (await publish(draft.id, { title: "a", questionSetId: crypto.randomUUID() })).status,
    ).toBe(400);
  });

  it("keeps unresolved questions out of play until the owner sets an answer", async () => {
    const { draft } = await reviewed();
    const result = await publish(draft.id, { title: "Needs answer" });
    const [unresolved] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.questionSetId, result.body.questionSetId),
          eq(questions.status, "excluded"),
        ),
      );

    const blocked = await call(restorePost, "/x", {
      method: "POST",
      params: { questionId: unresolved!.id },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("unresolved_answer");

    const withoutAnswer = await call(questionPatch, "/x", {
      method: "PATCH",
      body: { prompt: "Reworded" },
      params: { questionId: unresolved!.id },
    });
    expect(withoutAnswer.status).toBe(400);

    const fixed = await call(questionPatch, "/x", {
      method: "PATCH",
      body: { correctOptionIds: ["c"] },
      params: { questionId: unresolved!.id },
    });
    expect(fixed.status).toBe(200);
    const restored = await call(restorePost, "/x", {
      method: "POST",
      params: { questionId: unresolved!.id },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.question.status).toBe("active");
  });
});

describe("ownership", () => {
  it("returns 404 for every route when the resource belongs to someone else", async () => {
    const { body } = await upload(docxFile());
    const draft = body.import;
    const itemId = draft.items[0].id;

    expect((await upload(docxFile(), { as: bob })).status).toBe(404);
    expect((await getDraft(draft.id, bob)).status).toBe(404);
    expect((await patchItem(draft.id, itemId, { decision: "accepted" }, bob)).status).toBe(404);
    expect((await publish(draft.id, { title: "Mine now" }, bob)).status).toBe(404);

    // Nothing leaked or changed for the owner.
    const mine = await getDraft(draft.id);
    expect(mine.body.import.items[0].decision).toBe("pending");
    expect(mine.body.import.status).toBe("extracted");
  });

  it("requires a session", async () => {
    const { body } = await upload(docxFile());
    expect((await getDraft(body.import.id, null as unknown as TestUser)).status).toBe(401);
  });

  it("treats malformed ids as not found", async () => {
    expect((await getDraft("not-a-uuid")).status).toBe(404);
  });
});
