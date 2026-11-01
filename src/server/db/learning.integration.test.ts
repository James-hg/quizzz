import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSISTANCE_LEVELS,
  DEFAULT_POLICY_VERSION,
  schedulerPolicyConfigSchema,
  strongestAssistance,
} from "@/lib/schemas";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion, deleteQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { addSchedulerPolicy, getSchedulerPolicy } from "@/server/db/repositories/scheduler";
import {
  approvedHints,
  attempts,
  conceptEvidence,
  concepts,
  helpEvents,
  questionRevisions,
  reviewStates,
  schedulerPolicies,
  studySessions,
} from "@/server/db/schema";
import { startOrResumeSession } from "@/server/sessions/service";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
  await db.delete(schedulerPolicies).where(sql`${schedulerPolicies.version} like 'test-%'`);
});

/** The message of the database error under a drizzle "Failed query" wrapper. */
async function dbError(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return `${(error as Error).message} ${cause?.message ?? ""}`;
  }
  throw new Error("expected the database to refuse this");
}

async function seed() {
  const course = await createCourse(db, alice.id, { title: "C", subject: "S" });
  const set = await createQuestionSet(db, alice.id, course.id, "Set");
  const question = await createQuestion(
    db,
    alice.id,
    set.id,
    {
      type: "mcq_single",
      prompt: "Pick b",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correctOptionIds: ["b"],
    },
    true,
  );
  const { session } = await startOrResumeSession(db, alice.id, set.id, "requeue");
  return { course, set, question, session, revisionId: question.revisionId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const attemptFor = (
  s: Seeded,
  pass: 1 | 2,
  level: (typeof ASSISTANCE_LEVELS)[number] = "none",
) => ({
  sessionId: s.session.id,
  userId: alice.id,
  questionId: s.question.id,
  questionRevisionId: s.revisionId,
  response: { kind: "options" as const, selectedOptionIds: ["a"] },
  isCorrect: false,
  gradingOutcome: "incorrect" as const,
  idempotencyKey: `key-${crypto.randomUUID()}`,
  startedAt: new Date(),
  pass,
  assistanceLevel: level,
});

const helpFor = (s: Seeded, over: Partial<typeof helpEvents.$inferInsert> = {}) => ({
  userId: alice.id,
  sessionId: s.session.id,
  questionId: s.question.id,
  questionRevisionId: s.revisionId,
  pass: 1,
  action: "small_hint" as const,
  level: "conceptual_hint" as const,
  contentText: "Think about which option is second.",
  ...over,
});

describe("scheduler policy v1", () => {
  it("exists after migration and its config passes Zod", async () => {
    const policy = await getSchedulerPolicy(db, DEFAULT_POLICY_VERSION);
    expect(policy?.version).toBe("v1");
    expect(policy?.config).toEqual({
      inSessionRetry: { maxRetries: 1 },
      intervalsDays: [1, 3, 7, 14],
      assistedAdvances: false,
      onLapse: { stepBack: 1 },
      // Not in the stored row; the schema supplies the default.
      maxReviewsPerDay: 20,
    });
  });

  it("is what new sessions start with", async () => {
    const s = await seed();
    const [row] = await db.select().from(studySessions).where(eq(studySessions.id, s.session.id));
    expect(row?.policyVersion).toBe("v1");
  });

  it("fails loudly when a stored config is malformed, and refuses a bad new version", async () => {
    await db.insert(schedulerPolicies).values({
      version: "test-malformed",
      config: { intervalsDays: [3, 1] } as never,
    });
    await expect(getSchedulerPolicy(db, "test-malformed")).rejects.toThrow();
    await expect(
      addSchedulerPolicy(db, "test-bad", { intervalsDays: [] } as never),
    ).rejects.toThrow();
    expect(await getSchedulerPolicy(db, "test-bad")).toBeUndefined();
  });

  it("accepts a new valid version and keeps v1 as it was", async () => {
    const config = schedulerPolicyConfigSchema.parse({
      inSessionRetry: { maxRetries: 2 },
      intervalsDays: [2, 5, 10],
      assistedAdvances: false,
      onLapse: { stepBack: 2 },
    });
    await addSchedulerPolicy(db, "test-v2", config);
    expect((await getSchedulerPolicy(db, "test-v2"))?.config).toEqual(config);
    expect((await getSchedulerPolicy(db, "v1"))?.config.intervalsDays).toEqual([1, 3, 7, 14]);
  });

  it("is required: sessions and review states cannot point at an unknown version", async () => {
    const s = await seed();
    expect(
      await dbError(
        db
          .update(studySessions)
          .set({ policyVersion: "nope" })
          .where(eq(studySessions.id, s.session.id)),
      ),
    ).toMatch(/foreign key|violates/i);
    expect(
      await dbError(
        db
          .insert(reviewStates)
          .values({ userId: alice.id, questionId: s.question.id, policyVersion: "nope" }),
      ),
    ).toMatch(/foreign key|violates/i);
  });
});

describe("assistance level on attempts", () => {
  it("has the same order in the database as in the code", async () => {
    const rows = await db.execute<{ levels: string }>(
      sql`select array_to_string(enum_range(null::assistance_level), ',') as levels`,
    );
    expect(rows[0]?.levels).toBe(ASSISTANCE_LEVELS.join(","));
  });

  it("defaults to none and stores the strongest level used", async () => {
    const s = await seed();
    const first = await insertAttempt(db, attemptFor(s, 1));
    expect(first.assistanceLevel).toBe("none");
    const second = await insertAttempt(db, attemptFor(s, 2, "next_step_hint"));
    expect(second.assistanceLevel).toBe("next_step_hint");
    const [strongest] = await db.execute<{ top: string }>(
      sql`select max(assistance_level)::text as top from attempts where session_id = ${s.session.id}`,
    );
    expect(strongest?.top).toBe("next_step_hint");
    expect(strongestAssistance(["none", "next_step_hint"])).toBe("next_step_hint");
  });

  it("cannot be changed afterwards: attempts are never rewritten", async () => {
    const s = await seed();
    const attempt = await insertAttempt(db, attemptFor(s, 1));
    expect(
      await dbError(
        db
          .update(attempts)
          .set({ assistanceLevel: "solution_revealed" })
          .where(eq(attempts.id, attempt.id)),
      ),
    ).toMatch(/cannot be updated/);
  });

  it("rejects an unknown level", async () => {
    const s = await seed();
    expect(
      await dbError(insertAttempt(db, { ...attemptFor(s, 1), assistanceLevel: "magic" as never })),
    ).toMatch(/invalid input value for enum/i);
  });
});

describe("help events", () => {
  it("record each help request with its turn, source, and provider details", async () => {
    const s = await seed();
    const segment = crypto.randomUUID();
    const [event] = await db
      .insert(helpEvents)
      .values(
        helpFor(s, {
          sourceSegmentIds: [segment],
          provider: "gemini",
          model: "gemini-test",
          promptVersion: "tutor-1",
          latencyMs: 420,
        }),
      )
      .returning();
    expect(event).toMatchObject({
      pass: 1,
      action: "small_hint",
      level: "conceptual_hint",
      attemptId: null,
      sourceSegmentIds: [segment],
      provider: "gemini",
      latencyMs: 420,
    });
    expect(event?.createdAt).toBeInstanceOf(Date);
  });

  it("can reference a reusable approved hint instead of generated text", async () => {
    const s = await seed();
    const [hint] = await db
      .insert(approvedHints)
      .values({
        questionRevisionId: s.revisionId,
        level: "next_step_hint",
        text: "Look at the second option.",
        origin: "owner",
      })
      .returning();
    const [event] = await db
      .insert(helpEvents)
      .values(helpFor(s, { contentText: null, approvedHintId: hint!.id, level: "next_step_hint" }))
      .returning();
    expect(event?.approvedHintId).toBe(hint!.id);
  });

  it("need some content, a real hint level, and a real turn", async () => {
    const s = await seed();
    expect(await dbError(db.insert(helpEvents).values(helpFor(s, { contentText: null })))).toMatch(
      /help_events_content_chk/,
    );
    expect(await dbError(db.insert(helpEvents).values(helpFor(s, { level: "none" })))).toMatch(
      /help_events_level_chk/,
    );
    expect(
      await dbError(db.insert(helpEvents).values(helpFor(s, { level: "solution_revealed" }))),
    ).toMatch(/help_events_level_chk/);
    expect(await dbError(db.insert(helpEvents).values(helpFor(s, { pass: 3 })))).toMatch(
      /help_events_pass_chk/,
    );
  });

  it("belong to a turn, so a retry's help is kept apart from the first try's", async () => {
    const s = await seed();
    const a1 = await insertAttempt(db, attemptFor(s, 1, "conceptual_hint"));
    const a2 = await insertAttempt(db, attemptFor(s, 2, "full_explanation"));
    const [h1] = await db
      .insert(helpEvents)
      .values(helpFor(s, { pass: 1 }))
      .returning();
    const [h2] = await db
      .insert(helpEvents)
      .values(helpFor(s, { pass: 2, action: "full_explanation", level: "full_explanation" }))
      .returning();

    await db.update(helpEvents).set({ attemptId: a1.id }).where(eq(helpEvents.id, h1!.id));
    await db.update(helpEvents).set({ attemptId: a2.id }).where(eq(helpEvents.id, h2!.id));

    const forSecondTurn = await db
      .select()
      .from(helpEvents)
      .where(and(eq(helpEvents.sessionId, s.session.id), eq(helpEvents.pass, 2)));
    expect(forSecondTurn.map((e) => e.attemptId)).toEqual([a2.id]);
    const byAttempt = await db.select().from(helpEvents).where(eq(helpEvents.attemptId, a1.id));
    expect(byAttempt.map((e) => e.id)).toEqual([h1!.id]);
  });

  it("are write-once: only the link to the attempt may be filled in, and only once", async () => {
    const s = await seed();
    const attempt = await insertAttempt(db, attemptFor(s, 1));
    const other = await insertAttempt(db, attemptFor(s, 2));
    const [event] = await db.insert(helpEvents).values(helpFor(s)).returning();

    expect(
      await dbError(
        db.update(helpEvents).set({ contentText: "changed" }).where(eq(helpEvents.id, event!.id)),
      ),
    ).toMatch(/cannot be changed/);
    expect(
      await dbError(
        db
          .update(helpEvents)
          .set({ level: "full_explanation" })
          .where(eq(helpEvents.id, event!.id)),
      ),
    ).toMatch(/cannot be changed/);

    await db.update(helpEvents).set({ attemptId: attempt.id }).where(eq(helpEvents.id, event!.id));
    expect(
      await dbError(
        db.update(helpEvents).set({ attemptId: other.id }).where(eq(helpEvents.id, event!.id)),
      ),
    ).toMatch(/cannot be changed/);
    expect(
      await dbError(
        db.update(helpEvents).set({ attemptId: null }).where(eq(helpEvents.id, event!.id)),
      ),
    ).toMatch(/cannot be changed/);
  });

  it("can only be linked to an attempt of the same user, session, question, and turn", async () => {
    const s = await seed();
    const s2 = await seed();
    const retry = await insertAttempt(db, attemptFor(s, 2));
    const elsewhere = await insertAttempt(db, attemptFor(s2, 1));
    const [event] = await db
      .insert(helpEvents)
      .values(helpFor(s, { pass: 1 }))
      .returning();

    // Wrong turn, and an attempt from another session.
    expect(
      await dbError(
        db.update(helpEvents).set({ attemptId: retry.id }).where(eq(helpEvents.id, event!.id)),
      ),
    ).toMatch(/does not match/);
    expect(
      await dbError(
        db.update(helpEvents).set({ attemptId: elsewhere.id }).where(eq(helpEvents.id, event!.id)),
      ),
    ).toMatch(/does not match/);
    // The same check applies when the link is given at insert time.
    expect(
      await dbError(db.insert(helpEvents).values(helpFor(s, { pass: 1, attemptId: retry.id }))),
    ).toMatch(/does not match/);
  });

  it("make a question count as having history, so it is excluded rather than deleted", async () => {
    const s = await seed();
    await db.insert(helpEvents).values(helpFor(s));
    await expect(deleteQuestion(db, alice.id, s.question.id)).rejects.toMatchObject({
      status: 409,
      code: "has_history",
    });
  });
});

describe("approved hints", () => {
  it("are unique per revision and level, and only hold real hint levels", async () => {
    const s = await seed();
    const row = { questionRevisionId: s.revisionId, text: "Hint", origin: "owner" as const };
    await db.insert(approvedHints).values({ ...row, level: "conceptual_hint" });
    expect(
      await dbError(db.insert(approvedHints).values({ ...row, level: "conceptual_hint" })),
    ).toMatch(/approved_hints_revision_level_uq/);
    expect(await dbError(db.insert(approvedHints).values({ ...row, level: "none" }))).toMatch(
      /approved_hints_level_chk/,
    );
    expect(
      await dbError(db.insert(approvedHints).values({ ...row, level: "solution_revealed" })),
    ).toMatch(/approved_hints_level_chk/);
  });

  it("start unreviewed with the evidence status and segments recorded", async () => {
    const s = await seed();
    const segment = crypto.randomUUID();
    const [hint] = await db
      .insert(approvedHints)
      .values({
        questionRevisionId: s.revisionId,
        level: "partial_example",
        text: "Similar: ...",
        origin: "ai_proposed",
        sourceSegmentIds: [segment],
      })
      .returning();
    expect(hint).toMatchObject({
      evidenceStatus: "unresolved",
      sourceSegmentIds: [segment],
      origin: "ai_proposed",
    });
  });

  it("go away with a never-attempted question instead of blocking its deletion", async () => {
    const s = await seed();
    await db.insert(approvedHints).values({
      questionRevisionId: s.revisionId,
      level: "conceptual_hint",
      text: "x",
      origin: "owner",
    });
    // An abandoned-session placeholder would block deletion; there is none, so this succeeds.
    await db
      .update(studySessions)
      .set({ state: "abandoned" })
      .where(eq(studySessions.id, s.session.id));
    await deleteQuestion(db, alice.id, s.question.id);
    expect(
      await db
        .select()
        .from(approvedHints)
        .where(eq(approvedHints.questionRevisionId, s.revisionId)),
    ).toEqual([]);
    expect(
      await db.select().from(questionRevisions).where(eq(questionRevisions.id, s.revisionId)),
    ).toEqual([]);
  });
});

describe("review states", () => {
  it("start as new with zeroed counters under policy v1", async () => {
    const s = await seed();
    const [state] = await db
      .insert(reviewStates)
      .values({ userId: alice.id, questionId: s.question.id })
      .returning();
    expect(state).toMatchObject({
      state: "new",
      stepIndex: 0,
      nextDueAt: null,
      lastIndependentSuccessAt: null,
      delayedSuccessCount: 0,
      distinctSuccessDays: 0,
      lapses: 0,
      policyVersion: "v1",
    });
  });

  it("are unique per user and question, but each user has their own", async () => {
    const s = await seed();
    await db.insert(reviewStates).values({ userId: alice.id, questionId: s.question.id });
    expect(
      await dbError(
        db.insert(reviewStates).values({ userId: alice.id, questionId: s.question.id }),
      ),
    ).toMatch(/review_states_user_question_uq/);
    await db.insert(reviewStates).values({ userId: bob.id, questionId: s.question.id });
    await db.delete(reviewStates).where(eq(reviewStates.userId, bob.id));
  });

  it("store due dates as timestamptz and reject negative counters", async () => {
    const s = await seed();
    const due = new Date("2026-11-05T17:30:00Z");
    const [state] = await db
      .insert(reviewStates)
      .values({
        userId: alice.id,
        questionId: s.question.id,
        state: "learning",
        nextDueAt: due,
        stepIndex: 2,
      })
      .returning();
    expect(state?.nextDueAt?.toISOString()).toBe(due.toISOString());
    const [type] = await db.execute<{ t: string }>(
      sql`select data_type as t from information_schema.columns where table_name = 'review_states' and column_name = 'next_due_at'`,
    );
    expect(type?.t).toBe("timestamp with time zone");
    expect(
      await dbError(
        db.update(reviewStates).set({ lapses: -1 }).where(eq(reviewStates.id, state!.id)),
      ),
    ).toMatch(/review_states_counts_chk/);
  });

  it("can be found by what is due for one user", async () => {
    const s = await seed();
    await db.insert(reviewStates).values({
      userId: alice.id,
      questionId: s.question.id,
      nextDueAt: new Date("2026-01-01T00:00:00Z"),
    });
    const due = await db
      .select()
      .from(reviewStates)
      .where(and(eq(reviewStates.userId, alice.id), sql`${reviewStates.nextDueAt} <= now()`));
    expect(due.map((r) => r.questionId)).toContain(s.question.id);
  });
});

describe("concepts and concept evidence", () => {
  it("keeps independent and assisted outcomes apart, one row per user and concept", async () => {
    const s = await seed();
    const [concept] = await db
      .insert(concepts)
      .values({ courseId: s.course.id, ownerId: alice.id, name: "Loops" })
      .returning();
    const [evidence] = await db
      .insert(conceptEvidence)
      .values({ userId: alice.id, conceptId: concept!.id })
      .returning();
    expect(evidence).toMatchObject({
      independentCorrect: 0,
      assistedCorrect: 0,
      newProblemChecks: 0,
      lastAt: null,
    });

    await db
      .update(conceptEvidence)
      .set({ independentCorrect: 3, assistedCorrect: 1, newProblemChecks: 1, lastAt: new Date() })
      .where(and(eq(conceptEvidence.userId, alice.id), eq(conceptEvidence.conceptId, concept!.id)));
    const [after] = await db
      .select()
      .from(conceptEvidence)
      .where(eq(conceptEvidence.conceptId, concept!.id));
    expect(after).toMatchObject({ independentCorrect: 3, assistedCorrect: 1 });

    expect(
      await dbError(
        db.insert(conceptEvidence).values({ userId: alice.id, conceptId: concept!.id }),
      ),
    ).toMatch(/concept_evidence_user_concept_uq/);
    expect(
      await dbError(
        db
          .update(conceptEvidence)
          .set({ assistedCorrect: -1 })
          .where(eq(conceptEvidence.conceptId, concept!.id)),
      ),
    ).toMatch(/concept_evidence_counts_chk/);
  });

  it("have unique names within a course", async () => {
    const s = await seed();
    await db
      .insert(concepts)
      .values({ courseId: s.course.id, ownerId: alice.id, name: "Recursion" });
    expect(
      await dbError(
        db.insert(concepts).values({ courseId: s.course.id, ownerId: alice.id, name: "Recursion" }),
      ),
    ).toMatch(/concepts_course_name_uq/);
    const other = await createCourse(db, alice.id, { title: "Other", subject: "S" });
    await db.insert(concepts).values({ courseId: other.id, ownerId: alice.id, name: "Recursion" });
  });

  it("must belong to real users and concepts", async () => {
    const s = await seed();
    expect(
      await dbError(
        db.insert(conceptEvidence).values({ userId: alice.id, conceptId: crypto.randomUUID() }),
      ),
    ).toMatch(/foreign key|violates/i);
    expect(
      await dbError(
        db
          .insert(concepts)
          .values({ courseId: s.course.id, ownerId: crypto.randomUUID(), name: "X" }),
      ),
    ).toMatch(/foreign key|violates/i);
  });
});
