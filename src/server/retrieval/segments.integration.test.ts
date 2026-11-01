import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as segmentGet } from "@/app/api/sources/segments/[segmentId]/route";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { questionSourceLinks, sourceDocuments, sourceSegments } from "@/server/db/schema";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { findRelevantSegments, getOwnedSegment } from "./segments";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let aliceCourse: string;
let aliceOther: string;
let bobCourse: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  aliceCourse = (await createCourse(db, alice.id, { title: "CS", subject: "S" })).id;
  aliceOther = (await createCourse(db, alice.id, { title: "Math", subject: "S" })).id;
  bobCourse = (await createCourse(db, bob.id, { title: "CS", subject: "S" })).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
});

type Seg = { text: string; anchor?: Record<string, unknown>; kind?: "paragraph" | "heading" };

async function document(
  userId: string,
  courseId: string,
  segments: Seg[],
  filename = "notes.docx",
) {
  const [doc] = await db
    .insert(sourceDocuments)
    .values({
      ownerId: userId,
      courseId,
      filename,
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      storageKey: `k-${randomUUID()}`,
      sha256: randomUUID(),
    })
    .returning();
  const rows = await db
    .insert(sourceSegments)
    .values(
      segments.map((s, i) => ({
        sourceDocumentId: doc!.id,
        ordinal: i,
        kind: s.kind ?? ("paragraph" as const),
        text: s.text,
        anchor: (s.anchor ?? { paragraphIndex: i }) as never,
      })),
    )
    .returning();
  return { doc: doc!, segments: rows.sort((a, b) => a.ordinal - b.ordinal) };
}

async function questionIn(courseId: string, userId = alice.id) {
  const set = await createQuestionSet(db, userId, courseId, `Set ${randomUUID()}`);
  return createQuestion(
    db,
    userId,
    set.id,
    {
      type: "mcq_single",
      prompt: "Which?",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correctOptionIds: ["a"],
    },
    true,
  );
}

const find = (over: Partial<Parameters<typeof findRelevantSegments>[1]> = {}) =>
  findRelevantSegments(db, { userId: alice.id, courseId: aliceCourse, query: "", ...over });

describe("the search index", () => {
  it("indexes new text, follows edits, and exists as a GIN index", async () => {
    const { segments } = await document(alice.id, aliceCourse, [
      { text: "Closures capture scope" },
    ]);
    const match = (word: string) =>
      db.execute(
        sql`select 1 from source_segments where id = ${segments[0]!.id} and search_vector @@ plainto_tsquery('simple', ${word})`,
      );
    expect(await match("closures")).toHaveLength(1);
    expect(await match("generators")).toHaveLength(0);

    await db
      .update(sourceSegments)
      .set({ text: "Generators yield values" })
      .where(eq(sourceSegments.id, segments[0]!.id));
    expect(await match("generators")).toHaveLength(1);
    expect(await match("closures")).toHaveLength(0);

    const [idx] = await db.execute<{ def: string }>(
      sql`select indexdef as def from pg_indexes where indexname = 'source_segments_search_idx'`,
    );
    expect(idx!.def).toMatch(/USING gin \(search_vector\)/);
  });
});

describe("findRelevantSegments", () => {
  it("never returns another user's segments, even for identical text", async () => {
    const token = `isolation${randomUUID().replaceAll("-", "")}`;
    const mine = await document(alice.id, aliceCourse, [{ text: `About ${token} here` }]);
    const theirs = await document(bob.id, bobCourse, [{ text: `About ${token} here too` }]);
    const found = await find({ query: token });
    expect(found.map((s) => s.id)).toEqual([mine.segments[0]!.id]);
    expect(found.map((s) => s.id)).not.toContain(theirs.segments[0]!.id);

    // Bob's course is not Alice's to ask about, and the answer does not say it exists.
    await expect(
      findRelevantSegments(db, { userId: alice.id, courseId: bobCourse, query: token }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("stays inside the course", async () => {
    const token = `course${randomUUID().replaceAll("-", "")}`;
    await document(alice.id, aliceOther, [{ text: `${token} in the other course` }]);
    expect(await find({ query: token })).toEqual([]);
  });

  it("puts linked passages first, then ranked hits, without repeats", async () => {
    const token = `linked${randomUUID().replaceAll("-", "")}`;
    const { segments } = await document(alice.id, aliceCourse, [
      { text: "Unrelated opening paragraph" },
      { text: `${token} ${token} ${token} strongest match` },
      { text: `weaker ${token} match` },
      { text: "Linked but does not mention the term" },
      { text: "Also linked, as evidence" },
    ]);
    const q = await questionIn(aliceCourse);
    await db.insert(questionSourceLinks).values([
      {
        questionRevisionId: q.revisionId,
        sourceSegmentId: segments[3]!.id,
        relationship: "origin",
      },
      {
        questionRevisionId: q.revisionId,
        sourceSegmentId: segments[4]!.id,
        relationship: "evidence",
      },
      // Linked twice: still returned once.
      {
        questionRevisionId: q.revisionId,
        sourceSegmentId: segments[4]!.id,
        relationship: "origin",
      },
      // A linked passage that also matches the search is not repeated.
      {
        questionRevisionId: q.revisionId,
        sourceSegmentId: segments[2]!.id,
        relationship: "origin",
      },
    ]);

    const found = await find({ query: token, questionRevisionId: q.revisionId });
    expect(found.map((s) => [s.id, s.origin])).toEqual([
      [segments[2]!.id, "linked"],
      [segments[3]!.id, "linked"],
      [segments[4]!.id, "linked"],
      [segments[1]!.id, "search"],
    ]);
  });

  it("ranks better matches first and breaks ties by reading order", async () => {
    const token = `rank${randomUUID().replaceAll("-", "")}`;
    const { segments } = await document(alice.id, aliceCourse, [
      { text: `${token} once` },
      { text: `${token} ${token} ${token}` },
      { text: `${token} once` },
    ]);
    const found = await find({ query: token });
    expect(found.map((s) => s.id)).toEqual([segments[1]!.id, segments[0]!.id, segments[2]!.id]);
  });

  it("matches on any word of a question, not all of them", async () => {
    const a = `alpha${randomUUID().replaceAll("-", "")}`;
    const b = `beta${randomUUID().replaceAll("-", "")}`;
    const { segments } = await document(alice.id, aliceCourse, [{ text: `only ${a} appears` }]);
    const found = await find({ query: `What is ${a} and ${b}?` });
    expect(found.map((s) => s.id)).toEqual([segments[0]!.id]);
  });

  it("returns nothing for an empty, punctuation-only or unmatched query", async () => {
    await document(alice.id, aliceCourse, [{ text: "Plenty of ordinary text here" }]);
    for (const query of [
      "",
      "   ",
      "?!.,;:",
      "(((",
      `nomatch${randomUUID().replaceAll("-", "")}`,
    ]) {
      expect(await find({ query })).toEqual([]);
    }
  });

  it("does not let query text act as search syntax or SQL", async () => {
    const token = `safe${randomUUID().replaceAll("-", "")}`;
    const { segments } = await document(alice.id, aliceCourse, [{ text: `${token} text` }]);
    const found = await find({ query: `${token}'; drop table source_segments; -- & | ! ( ) :*` });
    expect(found.map((s) => s.id)).toContain(segments[0]!.id);
    expect((await db.select().from(sourceSegments).limit(1)).length).toBe(1);
  });

  it("respects the passage limit", async () => {
    const token = `limit${randomUUID().replaceAll("-", "")}`;
    await document(
      alice.id,
      aliceCourse,
      Array.from({ length: 6 }, (_, i) => ({ text: `${token} passage ${i}` })),
    );
    expect(await find({ query: token, limit: 4 })).toHaveLength(4);
    expect(await find({ query: token })).toHaveLength(6);
  });

  it("respects the character budget by skipping passages, never cutting them", async () => {
    const token = `budget${randomUUID().replaceAll("-", "")}`;
    const long = `${token} ${"x".repeat(200)}`;
    const short = `${token} short`;
    const { segments } = await document(alice.id, aliceCourse, [
      { text: `${token} ${token} ${long}` }, // best rank, too long for the budget
      { text: short },
      { text: `${short} two` },
    ]);
    const found = await find({ query: token, maxChars: 100 });
    expect(found.map((s) => s.id)).toEqual([segments[1]!.id, segments[2]!.id]);
    expect(found.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(100);
    for (const s of found) {
      const [row] = await db.select().from(sourceSegments).where(eq(sourceSegments.id, s.id));
      expect(s.text).toBe(row!.text);
    }
  });

  it("applies the budget to linked passages too", async () => {
    const { segments } = await document(alice.id, aliceCourse, [
      { text: "L".repeat(100) },
      { text: "short linked" },
    ]);
    const q = await questionIn(aliceCourse);
    await db.insert(questionSourceLinks).values(
      segments.map((s) => ({
        questionRevisionId: q.revisionId,
        sourceSegmentId: s.id,
        relationship: "origin" as const,
      })),
    );
    const found = await find({ questionRevisionId: q.revisionId, maxChars: 50 });
    expect(found.map((s) => s.id)).toEqual([segments[1]!.id]);
  });

  it("refuses a question that is not the user's, or not in the course", async () => {
    const bobQuestion = await questionIn(bobCourse, bob.id);
    await expect(find({ questionRevisionId: bobQuestion.revisionId })).rejects.toMatchObject({
      status: 404,
    });
    const otherCourse = await questionIn(aliceOther);
    await expect(find({ questionRevisionId: otherCourse.revisionId })).rejects.toMatchObject({
      status: 404,
    });
    await expect(find({ questionRevisionId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  });

  it("rejects out-of-range limits and budgets before touching the database", async () => {
    await expect(find({ limit: 0 })).rejects.toThrow();
    await expect(find({ limit: 21 })).rejects.toThrow();
    await expect(find({ maxChars: 0 })).rejects.toThrow();
    await expect(find({ maxChars: 20_001 })).rejects.toThrow();
  });
});

describe("opening a citation", () => {
  const open = (user: TestUser | null, segmentId: string) =>
    call(segmentGet, "/api/x", user, { params: { segmentId } });

  it("returns the exact passage, document name and an honest location for every retrieved id", async () => {
    const token = `cite${randomUUID().replaceAll("-", "")}`;
    const text = `${token}\n  exact   text with  odd   spacing — and “quotes”`;
    const { segments } = await document(
      alice.id,
      aliceCourse,
      [
        { text, anchor: { paragraphIndex: 4, headingPath: ["Week 2", "Closures"] } },
        { text: `${token} slide`, anchor: { slide: 3 } },
        { text: `${token} page`, anchor: { page: 7 } },
      ],
      "week2.docx",
    );
    const found = await find({ query: token });
    expect(found).toHaveLength(3);
    for (const hit of found) {
      const res = await open(alice, hit.id);
      expect(res.status).toBe(200);
      const [row] = await db.select().from(sourceSegments).where(eq(sourceSegments.id, hit.id));
      expect(res.body.segment).toMatchObject({
        id: hit.id,
        text: row!.text,
        filename: "week2.docx",
        anchor: row!.anchor,
        sourceDocumentId: row!.sourceDocumentId,
      });
      expect(res.body.segment.text).toBe(hit.text);
      expect(res.body.segment.location).toBe(hit.location);
    }
    const byId = new Map(found.map((s) => [s.id, s.location]));
    expect(byId.get(segments[0]!.id)).toBe('paragraph 5, under "Week 2 > Closures"');
    expect(byId.get(segments[1]!.id)).toBe("slide 3");
    expect(byId.get(segments[2]!.id)).toBe("page 7");
    const res = await open(alice, segments[0]!.id);
    expect(res.body.segment.text).toBe(text);
    expect(Object.keys(res.body.segment).sort()).toEqual(
      ["anchor", "filename", "id", "kind", "location", "sourceDocumentId", "text"].sort(),
    );
  });

  it("is private to the owner and says nothing about existence", async () => {
    const { segments } = await document(alice.id, aliceCourse, [{ text: "Private passage" }]);
    const id = segments[0]!.id;
    expect((await open(bob, id)).status).toBe(404);
    expect((await open(bob, randomUUID())).body).toEqual((await open(bob, id)).body);
    expect((await open(null, id)).status).toBe(401);
    expect((await open(alice, "not-a-uuid")).status).toBe(404);
    expect((await open(alice, randomUUID())).status).toBe(404);
    await expect(getOwnedSegment(db, bob.id, id)).rejects.toMatchObject({ status: 404 });
  });

  it("is not cached by shared caches", async () => {
    const { segments } = await document(alice.id, aliceCourse, [{ text: "Cache me not" }]);
    const { authRequest } = await import("@/test/auth-helpers");
    const response = await segmentGet(authRequest("/api/x", { cookie: alice.cookie }), {
      params: Promise.resolve({ segmentId: segments[0]!.id }),
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("is gone when its document is deleted", async () => {
    const { doc, segments } = await document(alice.id, aliceCourse, [{ text: "Soon deleted" }]);
    await db.delete(sourceDocuments).where(eq(sourceDocuments.id, doc.id));
    expect((await open(alice, segments[0]!.id)).status).toBe(404);
  });
});
