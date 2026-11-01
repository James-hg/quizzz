import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as saveProposalsPost } from "@/app/api/ai/question-sets/[setId]/save-proposals/route";
import { POST as approvePost } from "@/app/api/question-revisions/[revisionId]/approve/route";
import { POST as editPost } from "@/app/api/question-revisions/[revisionId]/edit/route";
import { POST as rejectPost } from "@/app/api/question-revisions/[revisionId]/reject/route";
import { GET as queueGet } from "@/app/api/courses/[courseId]/review-queue/route";
import { POST as bulkPost } from "@/app/api/courses/[courseId]/review-queue/approve-selected/route";
import { saveProposals } from "@/server/ai/proposals";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { getQuestion, listPlayableItems, setQuestionStatus } from "@/server/content/questions";
import { acceptRewrite, saveRewrite } from "@/server/content/rewrites";
import { getDb } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import {
  contentChecks,
  contentReviewDecisions,
  questionRevisions,
  questionSets,
  questionSourceLinks,
  questions,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { latestChecks } from "./service";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let courseId: string;
let bobCourseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  courseId = (await createCourse(db, alice.id, { title: "CS", subject: "S" })).id;
  bobCourseId = (await createCourse(db, bob.id, { title: "CS", subject: "S" })).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
});

const OPTIONS = [
  { id: "a", text: "A" },
  { id: "b", text: "B" },
  { id: "c", text: "C" },
];

const content = (over: Record<string, unknown> = {}) =>
  ({
    type: "mcq_single",
    prompt: `Which is right? ${randomUUID()}`,
    options: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ],
    correctOptionIds: ["b"],
    ...over,
  }) as never;

async function makeSet(origin: "manual" | "imported" = "manual") {
  const set = await createQuestionSet(db, alice.id, courseId, `Set ${randomUUID()}`);
  if (origin === "imported") {
    await db.update(questionSets).set({ origin: "imported" }).where(eq(questionSets.id, set.id));
  }
  return set;
}

async function document(texts: string[], owner = alice, course = courseId) {
  const [doc] = await db
    .insert(sourceDocuments)
    .values({
      ownerId: owner.id,
      courseId: course,
      filename: "notes.docx",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      storageKey: `k-${randomUUID()}`,
      sha256: randomUUID(),
    })
    .returning();
  return db
    .insert(sourceSegments)
    .values(
      texts.map((text, i) => ({
        sourceDocumentId: doc!.id,
        ordinal: i,
        kind: "paragraph" as const,
        text,
        anchor: { paragraphIndex: i },
      })),
    )
    .returning();
}

const approve = (revisionId: string, body: object = { confirmed: true }, as = alice) =>
  call(approvePost, "/api/x", as, { body, params: { revisionId } });
const reject = (revisionId: string, as = alice) =>
  call(rejectPost, "/api/x", as, { body: { confirmed: true }, params: { revisionId } });
const edit = (revisionId: string, body: object, as = alice) =>
  call(editPost, "/api/x", as, { body, params: { revisionId } });
const queue = (id = courseId, as: TestUser | null = alice) =>
  call(queueGet, "/api/x", as, { params: { courseId: id } });
const bulk = (revisionIds: string[], id = courseId, as = alice) =>
  call(bulkPost, "/api/x", as, {
    body: { confirmed: true, revisionIds },
    params: { courseId: id },
  });
const playable = async (setId: string) =>
  (await listPlayableItems(db, setId)).map((i) => i.questionId);

describe("saving generated proposals", () => {
  it("records a check run, keeps them excluded and unreviewed, and never calls them verified", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    expect(q).toMatchObject({ status: "excluded", evidenceStatus: "generated_unreviewed" });
    const run = await latestChecks(db, q!.revisionId);
    expect(run!.results.map((r) => r.name).sort()).toEqual(
      [
        "correct_option_count",
        "excerpt_fidelity",
        "explanation_answer_agreement",
        "imported_key_agreement",
        "schema_valid",
        "source_ids",
        "supported_type",
      ].sort(),
    );
    expect(run!.results.find((r) => r.name === "schema_valid")!.result).toBe("pass");
    // Nothing to look at is "not applicable", never a pass.
    expect(run!.results.find((r) => r.name === "source_ids")!.result).toBe("not_applicable");
    expect(await playable(set.id)).toEqual([]);
    const statuses = (await db.select().from(questionRevisions)).map((r) => r.evidenceStatus);
    expect(statuses).not.toContain("deterministically_checked");
  });

  it("refuses a single-choice proposal with two correct options and stores nothing", async () => {
    const set = await makeSet();
    const res = await call(saveProposalsPost, "/api/x", alice, {
      body: { proposals: [content({ correctOptionIds: ["a", "b"] })] },
      params: { setId: set.id },
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(questions).where(eq(questions.questionSetId, set.id))).toEqual(
      [],
    );
  });

  it("quarantines an already stored question with two correct options: it cannot be approved", async () => {
    const set = await makeSet();
    const [q] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position: 0, status: "excluded" })
      .returning();
    const bad = await addRevision(db, q!.id, {
      type: "mcq_single",
      prompt: "Broken",
      codeSnippet: null,
      explanation: null,
      options: OPTIONS,
      answerKey: { kind: "options", correctOptionIds: ["a", "b"] },
      origin: "ai_proposed",
      evidenceStatus: "generated_unreviewed",
      createdBy: alice.id,
    });
    const res = await approve(bad.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "checks_failed" });
    expect(res.body.error.details.failed).toEqual(
      expect.arrayContaining(["schema_valid", "correct_option_count"]),
    );
    expect((await getQuestion(db, alice.id, q!.id)).evidenceStatus).toBe("generated_unreviewed");
    expect(await playable(set.id)).toEqual([]);
    await expect(setQuestionStatus(db, alice.id, q!.id, "active")).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("approving", () => {
  it("records human_reviewed and the owner's decision, restores the proposal, and keeps history", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const res = await approve(q!.revisionId);
    expect(res.status).toBe(200);
    expect(res.body.question).toMatchObject({
      status: "active",
      evidenceStatus: "human_reviewed",
      origin: "ai_proposed",
      revisionNumber: 2,
    });
    expect(await playable(set.id)).toEqual([q!.id]);

    // The proposal revision is untouched; the decision belongs to the approved revision.
    const [old] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, q!.revisionId));
    expect(old!.evidenceStatus).toBe("generated_unreviewed");
    const decisions = await db
      .select()
      .from(contentReviewDecisions)
      .where(eq(contentReviewDecisions.questionRevisionId, res.body.question.revisionId));
    expect(decisions).toEqual([
      expect.objectContaining({ decision: "approve", reviewerId: alice.id, conflictReason: null }),
    ]);
    expect(decisions[0]!.checkRunId).toBeTruthy();
  });

  it("repeats safely, and refuses an old revision after the question moved on", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const first = await approve(q!.revisionId);
    const again = await approve(first.body.question.revisionId);
    expect(again.status).toBe(200);
    expect(again.body.question.revisionNumber).toBe(2);
    const stale = await approve(q!.revisionId);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("stale_revision");
  });

  it("requires the owner's confirmation", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    expect((await approve(q!.revisionId, {})).status).toBe(400);
    expect((await approve(q!.revisionId, { confirmed: false })).status).toBe(400);
  });

  it("does not restore a question the owner excluded for another reason", async () => {
    const set = await makeSet();
    const [q] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position: 0, status: "excluded" })
      .returning();
    const rev = await addRevision(db, q!.id, {
      type: "mcq_single",
      prompt: "Sample",
      codeSnippet: null,
      explanation: null,
      options: OPTIONS,
      answerKey: { kind: "options", correctOptionIds: ["b"] },
      origin: "sample",
      evidenceStatus: "needs_review",
      createdBy: alice.id,
    });
    const res = await approve(rev.id);
    expect(res.body.question).toMatchObject({
      evidenceStatus: "human_reviewed",
      status: "excluded",
    });
  });
});

describe("sources", () => {
  it("fails a fabricated or foreign source id and keeps the failure on the revision", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const [mine] = await document(["Closures capture variables"]);
    const [theirs] = await document(["Bob's notes"], bob, bobCourseId);

    for (const citations of [
      [{ segmentId: randomUUID() }],
      [{ segmentId: theirs!.id }],
      [{ segmentId: mine!.id }, { segmentId: randomUUID() }],
    ]) {
      const edited = await edit(q!.revisionId, {
        patch: { prompt: `Edited ${randomUUID()}` },
        citations,
      });
      expect(edited.status).toBe(200);
      const revId = edited.body.question.revisionId as string;
      expect(edited.body.question.evidenceStatus).toBe("generated_unreviewed");
      const run = await latestChecks(db, revId);
      expect(run!.results.find((r) => r.name === "source_ids")!.result).toBe("fail");
      // The invalid id is not linked, and approval still fails: dropping it does not clear it.
      const links = await db
        .select()
        .from(questionSourceLinks)
        .where(eq(questionSourceLinks.questionRevisionId, revId));
      expect(links.map((l) => l.sourceSegmentId)).not.toContain(theirs!.id);
      const res = await approve(revId);
      expect(res.status).toBe(409);
      expect(res.body.error.details.failed).toContain("source_ids");
      expect(await playable(set.id)).toEqual([]);
      // Reload the proposal so the next round edits a current revision.
      q!.revisionId = revId;
    }
  });

  it("checks quoted excerpts against the passage", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const [seg] = await document(["Closures capture   variables from the enclosing scope."]);

    const bad = await edit(q!.revisionId, {
      patch: { explanation: "See notes." },
      citations: [{ segmentId: seg!.id, excerpt: "closures copy variables" }],
    });
    expect((await approve(bad.body.question.revisionId)).body.error.details.failed).toContain(
      "excerpt_fidelity",
    );

    const good = await edit(bad.body.question.revisionId, {
      patch: { explanation: "See notes again." },
      citations: [{ segmentId: seg!.id, excerpt: "Closures capture variables" }],
    });
    const approved = await approve(good.body.question.revisionId);
    expect(approved.status).toBe(200);
    const links = await db
      .select()
      .from(questionSourceLinks)
      .where(eq(questionSourceLinks.questionRevisionId, approved.body.question.revisionId));
    expect(links).toEqual([
      expect.objectContaining({ sourceSegmentId: seg!.id, excerpt: "Closures capture variables" }),
    ]);
  });

  it("carries source links to every new revision", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const [seg] = await document(["A passage"]);
    const edited = await edit(q!.revisionId, {
      patch: { explanation: "Per the notes." },
      citations: [{ segmentId: seg!.id }],
    });
    const approved = await approve(edited.body.question.revisionId);
    const links = await db
      .select()
      .from(questionSourceLinks)
      .where(eq(questionSourceLinks.questionRevisionId, approved.body.question.revisionId));
    expect(links.map((l) => l.sourceSegmentId)).toEqual([seg!.id]);
  });
});

describe("disagreeing with the imported key", () => {
  async function importedWithConflict() {
    const set = await makeSet("imported");
    const [q] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position: 0 })
      .returning();
    const original = await addRevision(db, q!.id, {
      type: "mcq_single",
      prompt: "Imported",
      codeSnippet: null,
      explanation: null,
      options: OPTIONS,
      answerKey: { kind: "options", correctOptionIds: ["a"] },
      origin: "original",
      evidenceStatus: "human_reviewed",
      createdBy: alice.id,
    });
    const proposed = await addRevision(db, q!.id, {
      type: "mcq_single",
      prompt: "Imported",
      codeSnippet: null,
      explanation: null,
      options: OPTIONS,
      answerKey: { kind: "options", correctOptionIds: ["b"] },
      origin: "ai_variant",
      evidenceStatus: "needs_review",
      createdBy: alice.id,
    });
    return { set, q: q!, original, proposed };
  }

  it("shows the conflict with the imported key and leaves that key unchanged", async () => {
    const { q, original } = await importedWithConflict();
    const { body } = await queue();
    const item = body.questions.find((i: { question: { id: string } }) => i.question.id === q.id);
    expect(item.keyConflict).toBe(true);
    expect(item.importedKey).toEqual({ kind: "options", correctOptionIds: ["a"] });
    expect(item.question.answerKey).toEqual({ kind: "options", correctOptionIds: ["b"] });
    const [row] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, original.id));
    expect(row!.answerKey).toEqual({ kind: "options", correctOptionIds: ["a"] });
  });

  it("needs the owner's reason, records it, and still never alters the imported revision", async () => {
    const { q, original, proposed } = await importedWithConflict();
    const refused = await approve(proposed.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("key_conflict_reason_required");

    const ok = await approve(proposed.id, {
      confirmed: true,
      keyConflictReason: "The notes say B.",
    });
    expect(ok.status).toBe(200);
    const [decision] = await db
      .select()
      .from(contentReviewDecisions)
      .where(eq(contentReviewDecisions.questionRevisionId, ok.body.question.revisionId));
    expect(decision!.conflictReason).toBe("The notes say B.");
    const [row] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, original.id));
    expect(row!.answerKey).toEqual({ kind: "options", correctOptionIds: ["a"] });
    expect((await getQuestion(db, alice.id, q.id)).evidenceStatus).toBe("human_reviewed");
  });

  it("is not approved in bulk: conflicts need their own reason", async () => {
    const { proposed } = await importedWithConflict();
    const res = await bulk([proposed.id]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("bulk_blocked");
    expect(res.body.error.details.problems[0].code).toBe("key_conflict_reason_required");
  });

  it("applies to an accepted rewrite that changes the imported answer", async () => {
    const set = await makeSet("imported");
    const [q] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position: 0 })
      .returning();
    const base = await addRevision(db, q!.id, {
      type: "mcq_single",
      prompt: "What is 3 + 4?",
      codeSnippet: null,
      explanation: null,
      options: [
        { id: "a", text: "7" },
        { id: "b", text: "8" },
        { id: "c", text: "12" },
      ],
      answerKey: { kind: "options", correctOptionIds: ["a"] },
      origin: "original",
      evidenceStatus: "human_reviewed",
      createdBy: alice.id,
    });
    const rewrite = await saveRewrite(db, alice.id, q!.id, {
      mode: "vary_numbers",
      baseRevisionId: base.id,
      content: {
        type: "mcq_single",
        prompt: "What is 5 + 6?",
        options: [
          { id: "a", text: "10" },
          { id: "b", text: "12" },
          { id: "c", text: "11" },
        ],
        correctOptionIds: ["c"],
      } as never,
    });
    await expect(
      acceptRewrite(db, alice.id, rewrite.id, { confirmed: true, as: "revision" }),
    ).rejects.toMatchObject({ code: "key_conflict_reason_required" });

    const accepted = await acceptRewrite(db, alice.id, rewrite.id, {
      confirmed: true,
      as: "revision",
      keyConflictReason: "New numbers, so a new answer.",
    });
    expect(accepted.question.prompt).toBe("What is 5 + 6?");
    // The imported revision keeps its key.
    const [row] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, base.id));
    expect(row!.answerKey).toEqual({ kind: "options", correctOptionIds: ["a"] });
    const [decision] = await db
      .select()
      .from(contentReviewDecisions)
      .where(eq(contentReviewDecisions.questionRevisionId, accepted.question.revisionId));
    expect(decision!.conflictReason).toBe("New numbers, so a new answer.");
  });
});

describe("rejecting, editing and the queue", () => {
  it("rejects with a new revision, excludes it, and keeps the old one", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const res = await reject(q!.revisionId);
    expect(res.body.question).toMatchObject({ evidenceStatus: "rejected", status: "excluded" });
    expect(res.body.question.revisionNumber).toBe(2);
    const [old] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, q!.revisionId));
    expect(old!.evidenceStatus).toBe("generated_unreviewed");
    expect(await playable(set.id)).toEqual([]);
    const decisions = await db
      .select()
      .from(contentReviewDecisions)
      .where(eq(contentReviewDecisions.questionRevisionId, res.body.question.revisionId));
    expect(decisions[0]!.decision).toBe("reject");
    // A rejected question is not offered again.
    const { body } = await queue();
    expect(body.questions.map((i: { question: { id: string } }) => i.question.id)).not.toContain(
      q!.id,
    );
  });

  it("edits into a new revision that still waits for review, and re-checks it", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const res = await edit(q!.revisionId, {
      patch: { correctOptionIds: ["a", "b"] },
    });
    // Two correct options on a single-choice question cannot even be saved.
    expect(res.status).toBe(400);
    const ok = await edit(q!.revisionId, { patch: { correctOptionIds: ["c"] } });
    expect(ok.body.question).toMatchObject({
      evidenceStatus: "generated_unreviewed",
      revisionNumber: 2,
    });
    expect(await latestChecks(db, ok.body.question.revisionId)).not.toBeNull();
    expect(await playable(set.id)).toEqual([]);
  });

  it("lists generated, sample and rewrite items for the course, owner only", async () => {
    const set = await makeSet();
    const [gen] = await saveProposals(db, alice.id, set.id, [content()]);
    const [owned] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position: 5 })
      .returning();
    const own = await addRevision(db, owned!.id, {
      type: "mcq_single",
      prompt: "Mine",
      codeSnippet: null,
      explanation: null,
      options: OPTIONS,
      answerKey: { kind: "options", correctOptionIds: ["a"] },
      origin: "original",
      evidenceStatus: "human_reviewed",
      createdBy: alice.id,
    });
    const rewrite = await saveRewrite(db, alice.id, owned!.id, {
      mode: "rephrase",
      baseRevisionId: own.id,
      content: content({ prompt: "Mine, reworded", correctOptionIds: ["a"] }),
    });

    const { status, body } = await queue();
    expect(status).toBe(200);
    const ids = body.questions.map((i: { question: { id: string } }) => i.question.id);
    expect(ids).toContain(gen!.id);
    expect(ids).not.toContain(owned!.id);
    expect(body.questions[0].checks.length).toBe(7);
    const mine = body.rewrites.find((r: { id: string }) => r.id === rewrite.id);
    expect(mine).toMatchObject({ kind: "rewrite", stale: false });
    expect(mine.checks).toHaveLength(7);

    // Another user's course, and your own empty one.
    expect((await queue(courseId, bob)).status).toBe(404);
    expect((await queue(bobCourseId, bob)).body).toEqual({ questions: [], rewrites: [] });
    expect((await queue(bobCourseId, alice)).status).toBe(404);
    expect((await queue(courseId, null)).status).toBe(401);
  });

  it("is private: another user can neither decide nor read", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    expect((await approve(q!.revisionId, { confirmed: true }, bob)).status).toBe(404);
    expect((await reject(q!.revisionId, bob)).status).toBe(404);
    expect((await edit(q!.revisionId, { patch: { explanation: "x" } }, bob)).status).toBe(404);
    expect((await bulk([q!.revisionId], bobCourseId, bob)).status).toBe(409);
    expect((await getQuestion(db, alice.id, q!.id)).evidenceStatus).toBe("generated_unreviewed");
  });
});

describe("bulk approval", () => {
  it("approves several at once and brings them into practice", async () => {
    const set = await makeSet();
    const saved = await saveProposals(db, alice.id, set.id, [content(), content(), content()]);
    const res = await bulk(saved.map((s) => s.revisionId));
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(3);
    expect((await playable(set.id)).sort()).toEqual(saved.map((s) => s.id).sort());
  });

  it("changes nothing if any one cannot be approved", async () => {
    const set = await makeSet();
    const saved = await saveProposals(db, alice.id, set.id, [content(), content()]);
    await approve(saved[1]!.revisionId); // now the second is stale for the bulk request
    const other = await saveProposals(db, alice.id, set.id, [content()]);
    const res = await bulk([other[0]!.revisionId, saved[1]!.revisionId, saved[0]!.revisionId]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("bulk_blocked");
    expect(await playable(set.id)).toEqual([saved[1]!.id]);
    expect((await getQuestion(db, alice.id, other[0]!.id)).evidenceStatus).toBe(
      "generated_unreviewed",
    );
  });

  it("rejects more than 50, duplicates and revisions from another course", async () => {
    const ids = Array.from({ length: 51 }, () => randomUUID());
    expect((await bulk(ids)).status).toBe(400);
    const one = randomUUID();
    expect((await bulk([one, one])).status).toBe(400);
    const set = await createQuestionSet(db, bob.id, bobCourseId, "Bob");
    const [bq] = await saveProposals(db, bob.id, set.id, [content()]);
    expect((await bulk([bq!.revisionId])).status).toBe(409);
  });
});

describe("audit rows", () => {
  it("are appended, never rewritten, and reused when nothing changed", async () => {
    const set = await makeSet();
    const [q] = await saveProposals(db, alice.id, set.id, [content()]);
    const rows = () =>
      db.select().from(contentChecks).where(eq(contentChecks.questionRevisionId, q!.revisionId));
    const before = await rows();
    const { runContentChecks } = await import("./service");
    await runContentChecks(db, alice.id, q!.revisionId, { persist: true });
    expect(await rows()).toHaveLength(before.length);
    expect(new Set(before.map((r) => r.runId)).size).toBe(1);
    expect(before.every((r) => r.validatorVersion === "b6.1")).toBe(true);
  });
});
