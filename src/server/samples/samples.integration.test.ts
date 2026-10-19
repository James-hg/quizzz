import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-samples-"));
process.env.STORAGE_DIR = storageDir;
process.env.SAMPLES_DIR = "src/server/samples/__fixtures__";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { GET as listGet } from "@/app/api/samples/route";
import { POST as loadPost } from "@/app/api/samples/[language]/load/route";
import { PATCH as questionPatch } from "@/app/api/questions/[questionId]/route";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { assertOwnsCourse } from "@/server/auth/ownership";
import { deleteCourse } from "@/server/content/courses";
import { listPlayableQuestionIds } from "@/server/content/questions";
import { getDb } from "@/server/db";
import {
  courses,
  questionRevisions,
  questionSets,
  questionSourceLinks,
  questions,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { readSample, resolveSamplesDir } from "./directory";
import { loadSample, SAMPLE_MIME } from "./loader";
import { getStorage } from "@/server/storage";
import type { StorageAdapter } from "@/server/storage/types";

const db = getDb();
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
});

afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
  await rm(storageDir, { recursive: true, force: true });
});

async function call(
  handler: unknown,
  options: {
    method?: string;
    body?: unknown;
    as?: TestUser | null;
    params?: Record<string, string>;
  } = {},
) {
  const who = options.as === undefined ? alice : options.as;
  const request = authRequest("/x", {
    method: options.method ?? "POST",
    body: options.body,
    cookie: who?.cookie,
  });
  const response = await (
    handler as (r: Request, c: { params: Promise<never> }) => Promise<Response>
  )(request, { params: Promise.resolve((options.params ?? {}) as never) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const sampleOf = async (language: string) =>
  (await readSample(resolveSamplesDir(process.env.SAMPLES_DIR), language))!;

describe("loading a sample course", () => {
  let result: Awaited<ReturnType<typeof loadSample>>;

  it("creates a course, question set, questions, and source segments owned by the user", async () => {
    result = await loadSample(db, getStorage(), alice.id, await sampleOf("python"));
    expect(result).toMatchObject({ alreadyLoaded: false, questionCount: 2, needsReviewCount: 1 });

    const course = await assertOwnsCourse(db, alice.id, result.courseId);
    expect(course).toMatchObject({
      title: "Test Course (python)",
      subject: "Test subject",
      language: "python",
      ownerId: alice.id,
    });

    const [set] = await db
      .select()
      .from(questionSets)
      .where(eq(questionSets.id, result.questionSetId));
    expect(set).toMatchObject({ origin: "sample", ownerId: alice.id, courseId: course.id });

    const [doc] = await db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, set!.sourceDocumentId!));
    expect(doc).toMatchObject({
      mimeType: SAMPLE_MIME,
      ownerId: alice.id,
      extractionStatus: "extracted",
    });
    expect(await getStorage().exists(doc!.storageKey)).toBe(true);

    const segments = await db
      .select()
      .from(sourceSegments)
      .where(eq(sourceSegments.sourceDocumentId, doc!.id))
      .orderBy(asc(sourceSegments.ordinal));
    expect(segments.map((s) => [s.kind, s.text])).toEqual([
      ["heading", "Test section one"],
      ["paragraph", "First paragraph of test text."],
      ["paragraph", "Second paragraph of test text."],
      ["heading", "Test section two"],
      ["paragraph", "Only one paragraph here."],
    ]);
    expect(segments[1]!.anchor).toEqual({ paragraphIndex: 1, headingPath: ["Test section one"] });
  });

  it("stores questions as sample revisions, human reviewed only with provenance", async () => {
    const rows = await db
      .select({ q: questions, r: questionRevisions })
      .from(questions)
      .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
      .where(eq(questions.questionSetId, result.questionSetId))
      .orderBy(asc(questions.position));
    expect(rows.map((x) => x.r.origin)).toEqual(["sample", "sample"]);
    expect(rows.map((x) => x.r.evidenceStatus)).toEqual(["human_reviewed", "needs_review"]);
    expect(rows[0]!.r).toMatchObject({
      type: "mcq_single",
      prompt: "Test prompt with a checked answer",
      answerKey: { kind: "options", correctOptionIds: ["b"] },
    });
    expect(rows[1]!.r.answerKey).toEqual({
      kind: "text",
      accepted: ["answer one", "answer two"],
      caseSensitive: false,
    });
  });

  it("links each question to the segments of the sections it cites", async () => {
    const rows = await db
      .select({ id: questionRevisions.id, prompt: questionRevisions.prompt })
      .from(questions)
      .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
      .where(eq(questions.questionSetId, result.questionSetId))
      .orderBy(asc(questions.position));
    const counts = [];
    for (const row of rows) {
      const links = await db
        .select()
        .from(questionSourceLinks)
        .where(eq(questionSourceLinks.questionRevisionId, row.id));
      expect(links.every((l) => l.relationship === "evidence")).toBe(true);
      counts.push(links.length);
    }
    expect(counts).toEqual([3, 5]);
  });

  it("keeps unchecked questions out of practice until the owner approves them", async () => {
    const all = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.questionSetId, result.questionSetId))
      .orderBy(asc(questions.position));
    expect(await listPlayableQuestionIds(db, result.questionSetId)).toEqual([all[0]!.id]);

    const approved = await call(questionPatch, {
      method: "PATCH",
      body: { approve: true },
      params: { questionId: all[1]!.id },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.question).toMatchObject({
      evidenceStatus: "human_reviewed",
      origin: "sample",
    });
    expect(await listPlayableQuestionIds(db, result.questionSetId)).toEqual([
      all[0]!.id,
      all[1]!.id,
    ]);
  });
});

describe("loading twice", () => {
  it("is idempotent per user and language, including concurrent loads", async () => {
    const sample = await sampleOf("c");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => loadSample(db, getStorage(), bob.id, sample)),
    );
    expect(new Set(results.map((r) => r.courseId)).size).toBe(1);
    expect(results.filter((r) => !r.alreadyLoaded)).toHaveLength(1);

    const again = await loadSample(db, getStorage(), bob.id, sample);
    expect(again).toMatchObject({ alreadyLoaded: true, courseId: results[0]!.courseId });

    const owned = await db
      .select({ id: courses.id })
      .from(courses)
      .where(and(eq(courses.ownerId, bob.id), eq(courses.language, "c")));
    expect(owned).toHaveLength(1);
  });

  it("gives every user their own separate copy", async () => {
    const sample = await sampleOf("python");
    const forBob = await loadSample(db, getStorage(), bob.id, sample);
    const forAlice = await loadSample(db, getStorage(), alice.id, sample);
    expect(forBob.courseId).not.toBe(forAlice.courseId);
    await expect(assertOwnsCourse(db, bob.id, forAlice.courseId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("allows a fresh copy after the user deletes theirs", async () => {
    const sample = await sampleOf("c");
    const [existing] = await db
      .select({ id: courses.id })
      .from(courses)
      .where(and(eq(courses.ownerId, bob.id), eq(courses.language, "c")));
    await deleteCourse(db, bob.id, existing!.id);
    const fresh = await loadSample(db, getStorage(), bob.id, sample);
    expect(fresh.alreadyLoaded).toBe(false);
    expect(fresh.courseId).not.toBe(existing!.id);
  });
});

describe("failure handling", () => {
  it("rolls back and removes the stored file when loading fails", async () => {
    const sample = await sampleOf("c");
    const broken = structuredClone(sample);
    // Duplicate option ids pass the fixture schema only if tampered with after validation.
    broken.course.questions[0]!.content = {
      type: "mcq_single",
      prompt: "x",
      options: [
        { id: "a", text: "1" },
        { id: "a", text: "2" },
      ],
      correctOptionIds: ["a"],
    };
    const puts: string[] = [];
    const deletes: string[] = [];
    const real = getStorage();
    const spy: StorageAdapter = {
      put: async (data) => {
        const key = await real.put(data);
        puts.push(key);
        return key;
      },
      get: (k) => real.get(k),
      exists: (k) => real.exists(k),
      delete: async (k) => {
        deletes.push(k);
        await real.delete(k);
      },
    };
    const carol = await signUpUser(db);
    try {
      await expect(loadSample(db, spy, carol.id, broken)).rejects.toThrow();
      expect(puts).toHaveLength(1);
      expect(deletes).toEqual(puts);
      expect(await db.select().from(courses).where(eq(courses.ownerId, carol.id))).toEqual([]);
    } finally {
      await deleteUsers(db, [carol.id]);
    }
  });
});

describe("sample routes", () => {
  it("lists the available samples and requires a session", async () => {
    expect((await call(listGet, { method: "GET", as: null })).status).toBe(401);
    const { status, body } = await call(listGet, { method: "GET" });
    expect(status).toBe(200);
    expect(body.samples).toEqual([
      {
        language: "c",
        title: "Test Course (c)",
        subject: "Test subject",
        sectionCount: 0,
        questionCount: 1,
        checkedQuestionCount: 1,
      },
      {
        language: "python",
        title: "Test Course (python)",
        subject: "Test subject",
        sectionCount: 2,
        questionCount: 2,
        checkedQuestionCount: 1,
      },
    ]);
  });

  it("loads with 201 then returns the same copy with 200", async () => {
    const carol = await signUpUser(db);
    try {
      const first = await call(loadPost, { as: carol, params: { language: "c" } });
      expect(first.status).toBe(201);
      const second = await call(loadPost, { as: carol, params: { language: "c" } });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ alreadyLoaded: true, courseId: first.body.courseId });
    } finally {
      await deleteUsers(db, [carol.id]);
    }
  });

  it("returns 404 for unknown languages and languages without a sample", async () => {
    expect((await call(loadPost, { params: { language: "rust" } })).status).toBe(404);
    expect((await call(loadPost, { params: { language: "../../etc" } })).status).toBe(404);
    expect((await call(loadPost, { params: { language: "java" } })).status).toBe(404);
    expect((await call(loadPost, { as: null, params: { language: "c" } })).status).toBe(401);
  });

  it("skips directories starting with an underscore", async () => {
    const { body } = await call(listGet, { method: "GET" });
    expect(body.samples.map((s: { language: string }) => s.language)).not.toContain("_ignored");
  });
});
