import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyAttempt,
  dueAfter,
  dueItems,
  NEW_REVIEW_STATE,
  type AttemptFacts,
  type ReviewItem,
  type ReviewSnapshot,
} from "./core";
import { addDays, localDate, startOfLocalDay } from "./dates";
import { POLICY_V1 } from "./policy";

const TZ = "America/Vancouver";
const at = (iso: string) => new Date(iso);
const solo: AttemptFacts = {
  outcome: "correct",
  pass: 1,
  activityRole: "scored",
  assistance: "none",
  lastExposureAt: null,
};
const apply = (
  state: ReviewSnapshot,
  attempt: Partial<AttemptFacts>,
  now: string,
  opts: { tz?: string; exam?: string | null } = {},
) =>
  applyAttempt(
    state,
    { ...solo, ...attempt },
    POLICY_V1,
    at(now),
    opts.tz ?? TZ,
    opts.exam ?? null,
  );

// Noon Pacific on 2026-02-01, a Sunday.
const D0 = "2026-02-01T20:00:00Z";
const first = apply(NEW_REVIEW_STATE, {}, D0);

describe("applyAttempt", () => {
  it("starts the schedule at the first independent success", () => {
    expect(first.state).toMatchObject({
      state: "reviewing",
      stepIndex: 0,
      distinctSuccessDays: 1,
      delayedSuccessCount: 0,
    });
    expect(first.state.nextDueAt).toEqual(startOfLocalDay("2026-02-02", TZ));
    expect(first.reason).toMatch(/First check in 1 day/);
  });

  it("lengthens the interval after each delayed success: 1, 3, 7, 14, then stays at 14", () => {
    let state = first.state;
    let day = "2026-02-01";
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const due = state.nextDueAt!;
      const before = localDate(due, TZ);
      const out = apply(
        state,
        { lastExposureAt: at("2026-01-01T00:00:00Z") },
        `${before}T20:00:00Z`,
      );
      state = out.state;
      gaps.push(
        Math.round((Date.parse(localDate(state.nextDueAt!, TZ)) - Date.parse(before)) / 86_400_000),
      );
      day = before;
    }
    expect(gaps).toEqual([3, 7, 14, 14, 14]);
    expect(state.delayedSuccessCount).toBe(5);
    expect(day).toBeTruthy();
  });

  it("explains the schedule with the number of separate days", () => {
    const second = apply(first.state, { lastExposureAt: at(D0) }, "2026-02-02T20:00:00Z");
    expect(second.reason).toMatch(/Recalled on 2 separate days\. Next check in 3 days/);
  });

  describe("what does not count as independent recall", () => {
    it.each([
      ["a hint", "conceptual_hint"],
      ["a next-step hint", "next_step_hint"],
      ["a worked example", "partial_example"],
      ["a full explanation", "full_explanation"],
      ["the solution", "solution_revealed"],
    ] as const)("a correct answer after %s does not advance", (_label, assistance) => {
      const out = apply(first.state, { assistance }, "2026-02-02T20:00:00Z");
      expect(out.state.stepIndex).toBe(first.state.stepIndex);
      expect(out.state.delayedSuccessCount).toBe(0);
      expect(out.state.lastIndependentSuccessAt).toEqual(first.state.lastIndependentSuccessAt);
      expect(out.state.state).toBe("learning");
      expect(out.state.nextDueAt).toEqual(startOfLocalDay("2026-02-03", TZ));
    });

    it("does not start the schedule for a first answer that used help", () => {
      const out = apply(NEW_REVIEW_STATE, { assistance: "next_step_hint" }, D0);
      expect(out.state.lastIndependentSuccessAt).toBeNull();
      expect(out.state.state).toBe("learning");
      expect(out.reason).toMatch(/You needed a hint/);
    });

    it("says when the solution was seen", () => {
      expect(apply(first.state, { assistance: "solution_revealed" }, D0).reason).toMatch(
        /saw the solution/,
      );
    });

    it("lets a policy count hints, but never a revealed solution", () => {
      const policy = { ...POLICY_V1, assistedAdvances: true };
      const hinted = applyAttempt(
        first.state,
        { ...solo, assistance: "next_step_hint", lastExposureAt: at(D0) },
        policy,
        at("2026-02-02T20:00:00Z"),
        TZ,
        null,
      );
      expect(hinted.state.stepIndex).toBe(1);
      const revealed = applyAttempt(
        first.state,
        { ...solo, assistance: "solution_revealed" },
        policy,
        at("2026-02-02T20:00:00Z"),
        TZ,
        null,
      );
      expect(revealed.state.stepIndex).toBe(0);
    });

    it("does not count a success on the same day the answer was seen as delayed recall", () => {
      const out = apply(
        first.state,
        { lastExposureAt: at("2026-02-02T16:00:00Z") },
        "2026-02-02T20:00:00Z",
      );
      expect(out.state.stepIndex).toBe(0);
      expect(out.state.delayedSuccessCount).toBe(0);
      expect(out.reason).toMatch(/earlier today/);
    });

    it("does not advance when answered before it was due", () => {
      const out = apply(first.state, { lastExposureAt: at(D0) }, "2026-02-01T23:00:00Z");
      expect(out.state.stepIndex).toBe(0);
      expect(out.state.nextDueAt).toEqual(first.state.nextDueAt);
      expect(out.reason).toMatch(/early/);
    });

    it.each([
      ["a retry", { pass: 2, activityRole: "practice" as const }],
      ["a pre-question", { activityRole: "prequestion" as const }],
      ["a practice attempt", { activityRole: "practice" as const }],
    ])("%s never changes the schedule", (_l, extra) => {
      for (const outcome of ["correct", "incorrect"] as const) {
        const out = apply(first.state, { ...extra, outcome }, "2026-02-02T20:00:00Z");
        expect(out.state).toEqual(first.state);
        expect(out.changed).toBe(false);
      }
    });

    it("never treats an uncertain grade as a failure", () => {
      const out = apply(first.state, { outcome: "uncertain" }, "2026-02-02T20:00:00Z");
      expect(out.state).toEqual(first.state);
      expect(out.state.lapses).toBe(0);
    });

    it("leaves a paused question alone", () => {
      const paused = { ...first.state, state: "suspended" as const };
      expect(apply(paused, { outcome: "incorrect" }, D0).state).toEqual(paused);
    });
  });

  describe("misses", () => {
    it("a first miss is not a lapse and comes back tomorrow", () => {
      const out = apply(NEW_REVIEW_STATE, { outcome: "incorrect" }, D0);
      expect(out.state).toMatchObject({ state: "learning", stepIndex: 0, lapses: 0 });
      expect(out.state.nextDueAt).toEqual(startOfLocalDay("2026-02-02", TZ));
    });

    it("a miss on a recalled question is a lapse that steps back", () => {
      const advanced = { ...first.state, stepIndex: 2 };
      const out = apply(advanced, { outcome: "incorrect" }, "2026-02-09T20:00:00Z");
      expect(out.state).toMatchObject({ state: "learning", stepIndex: 1, lapses: 1 });
      expect(out.state.nextDueAt).toEqual(startOfLocalDay("2026-02-10", TZ));
    });

    it("a lapse never goes below the first step", () => {
      const out = apply(first.state, { outcome: "incorrect" }, "2026-02-02T20:00:00Z");
      expect(out.state.stepIndex).toBe(0);
    });

    it("a correct recall after a lapse restarts the climb", () => {
      const lapsed = apply(
        { ...first.state, stepIndex: 2 },
        { outcome: "incorrect" },
        "2026-02-09T20:00:00Z",
      ).state;
      const out = apply(
        lapsed,
        { lastExposureAt: at("2026-02-09T20:00:00Z") },
        "2026-02-10T20:00:00Z",
      );
      expect(out.state).toMatchObject({ state: "reviewing", stepIndex: 2 });
    });
  });

  describe("timezone and exam date", () => {
    it("schedules by the student's local day", () => {
      // 23:30 in Vancouver on Feb 1 is already Feb 2 in UTC.
      const late = "2026-02-02T07:30:00Z";
      const van = apply(NEW_REVIEW_STATE, {}, late, { tz: "America/Vancouver" });
      const utc = apply(NEW_REVIEW_STATE, {}, late, { tz: "UTC" });
      expect(van.state.nextDueAt).toEqual(startOfLocalDay("2026-02-02", "America/Vancouver"));
      expect(utc.state.nextDueAt).toEqual(startOfLocalDay("2026-02-03", "UTC"));
    });

    // Past dates only: a zone's rules for future years can still change.
    it("keeps one local day per interval across the spring clock change", () => {
      const out = apply(NEW_REVIEW_STATE, {}, "2025-03-08T20:00:00Z"); // Sat, PST
      expect(out.state.nextDueAt).toEqual(startOfLocalDay("2025-03-09", TZ));
      const next = apply(
        out.state,
        { lastExposureAt: at("2025-03-08T20:00:00Z") },
        "2025-03-09T20:00:00Z", // Sun, PDT
      );
      expect(localDate(next.state.nextDueAt!, TZ)).toBe("2025-03-12");
      expect(next.state.nextDueAt!.toISOString()).toBe("2025-03-12T07:00:00.000Z");
    });

    it("keeps one local day per interval across the autumn clock change", () => {
      const out = apply(NEW_REVIEW_STATE, {}, "2025-11-01T20:00:00Z"); // Sat, PDT
      const next = apply(
        { ...out.state, stepIndex: 1 },
        { lastExposureAt: at("2025-11-01T20:00:00Z") },
        "2025-11-02T20:00:00Z", // Sun, PST
      );
      expect(localDate(next.state.nextDueAt!, TZ)).toBe("2025-11-09");
      expect(next.state.nextDueAt!.toISOString()).toBe("2025-11-09T08:00:00.000Z");
    });

    it("works the same for a student in Sydney", () => {
      const out = apply(NEW_REVIEW_STATE, {}, "2025-10-04T01:00:00Z", { tz: "Australia/Sydney" });
      expect(localDate(out.state.nextDueAt!, "Australia/Sydney")).toBe("2025-10-05");
    });

    it("never schedules past the exam: the last review day is the day before", () => {
      const out = apply(
        { ...first.state, stepIndex: 2 },
        { lastExposureAt: at(D0) },
        "2026-02-08T20:00:00Z",
        { exam: "2026-02-15" },
      );
      expect(localDate(out.state.nextDueAt!, TZ)).toBe("2026-02-14");
    });

    it("has nothing to schedule on or after the exam, or when no review day is left", () => {
      expect(dueAfter(at("2026-02-14T20:00:00Z"), 1, TZ, "2026-02-15")).toBeNull();
      expect(dueAfter(at("2026-02-15T20:00:00Z"), 1, TZ, "2026-02-15")).toBeNull();
      expect(dueAfter(at("2026-02-20T20:00:00Z"), 1, TZ, "2026-02-15")).toBeNull();
      expect(
        apply(NEW_REVIEW_STATE, {}, "2026-02-15T20:00:00Z", { exam: "2026-02-15" }).reason,
      ).toMatch(/No review day is left/);
    });
  });

  describe("properties", () => {
    const outcomes = fc.constantFrom("correct", "incorrect", "uncertain" as const);
    const assistance = fc.constantFrom(
      "none",
      "conceptual_hint",
      "next_step_hint",
      "partial_example",
      "full_explanation",
      "solution_revealed",
    ) as fc.Arbitrary<AttemptFacts["assistance"]>;
    const step = fc.record({
      outcome: outcomes as fc.Arbitrary<AttemptFacts["outcome"]>,
      assistance,
      pass: fc.constantFrom(1, 2),
      activityRole: fc.constantFrom("scored", "practice", "prequestion") as fc.Arbitrary<
        AttemptFacts["activityRole"]
      >,
      gapHours: fc.integer({ min: 0, max: 24 * 40 }),
      seenEarlier: fc.boolean(),
    });
    const zone = fc.constantFrom("UTC", "America/Vancouver", "Australia/Sydney", "Asia/Kolkata");

    function run(
      steps: (typeof step extends fc.Arbitrary<infer T> ? T : never)[],
      tz: string,
      exam: string | null,
    ) {
      let state = NEW_REVIEW_STATE;
      let t = Date.parse("2026-01-10T15:00:00Z");
      const trail: {
        before: ReviewSnapshot;
        after: ReviewSnapshot;
        s: (typeof steps)[number];
        now: Date;
      }[] = [];
      for (const s of steps) {
        t += s.gapHours * 3_600_000;
        const now = new Date(t);
        const out = applyAttempt(
          state,
          {
            outcome: s.outcome,
            pass: s.pass,
            activityRole: s.activityRole,
            assistance: s.assistance,
            lastExposureAt: s.seenEarlier ? new Date(t - 3_600_000) : null,
          },
          POLICY_V1,
          now,
          tz,
          exam,
        );
        trail.push({ before: state, after: out.state, s, now });
        state = out.state;
      }
      return trail;
    }

    it("only independent first-try successes ever raise the step or the delayed count", () => {
      fc.assert(
        fc.property(fc.array(step, { maxLength: 30 }), zone, (steps, tz) => {
          for (const { before, after, s } of run(steps, tz, null)) {
            const independent =
              s.outcome === "correct" &&
              s.pass === 1 &&
              s.activityRole === "scored" &&
              s.assistance === "none";
            if (!independent) {
              expect(after.delayedSuccessCount).toBe(before.delayedSuccessCount);
              expect(after.stepIndex).toBeLessThanOrEqual(before.stepIndex);
              expect(after.lastIndependentSuccessAt).toEqual(before.lastIndependentSuccessAt);
            }
            if (s.outcome === "uncertain") expect(after).toEqual(before);
            expect(after.stepIndex).toBeLessThan(POLICY_V1.intervalsDays.length);
            expect(after.lapses).toBeGreaterThanOrEqual(before.lapses);
            expect(after.distinctSuccessDays).toBeGreaterThanOrEqual(before.distinctSuccessDays);
          }
        }),
      );
    });

    it("never schedules a review on or after the exam day, or in the past", () => {
      fc.assert(
        fc.property(fc.array(step, { minLength: 1, maxLength: 20 }), zone, (steps, tz) => {
          const exam = "2026-02-20";
          for (const { before, after, now } of run(steps, tz, exam)) {
            // An overdue date that nothing touched stays where it was.
            if (after.nextDueAt && after.nextDueAt !== before.nextDueAt) {
              expect(localDate(after.nextDueAt, tz) < exam).toBe(true);
              expect(after.nextDueAt.getTime()).toBeGreaterThan(now.getTime() - 1);
            }
          }
        }),
      );
    });

    it("is deterministic", () => {
      fc.assert(
        fc.property(fc.array(step, { maxLength: 15 }), zone, (steps, tz) => {
          expect(run(steps, tz, "2026-03-01")).toEqual(run(steps, tz, "2026-03-01"));
        }),
      );
    });
  });
});

describe("dueItems", () => {
  const item = (id: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
    ...first.state,
    questionId: id,
    ...over,
  });
  const now = at("2026-02-10T20:00:00Z");
  const day = (d: string) => startOfLocalDay(d, TZ);

  it("offers what is due by the end of the student's day, and nothing else", () => {
    const out = dueItems(
      [
        item("a", { nextDueAt: day("2026-02-10") }),
        item("b", { nextDueAt: day("2026-02-11") }),
        item("c", { nextDueAt: null }),
        item("d", { state: "new", nextDueAt: day("2026-02-01") }),
        item("e", { state: "suspended", nextDueAt: day("2026-02-01") }),
      ],
      now,
      TZ,
      null,
      POLICY_V1,
    );
    expect(out.today.map((i) => i.questionId)).toEqual(["a"]);
    expect(out.today[0]!.reason).toBe("Due today.");
  });

  it("puts relearning first, then the longest overdue, then by id", () => {
    const out = dueItems(
      [
        item("late-b", { nextDueAt: day("2026-02-05") }),
        item("late-a", { nextDueAt: day("2026-02-05") }),
        item("older", { nextDueAt: day("2026-02-01") }),
        item("hint", { state: "learning", nextDueAt: day("2026-02-10") }),
      ],
      now,
      TZ,
      null,
      POLICY_V1,
    );
    expect(out.today.map((i) => i.questionId)).toEqual(["hint", "older", "late-a", "late-b"]);
    expect(out.today[0]!.reason).toMatch(/missed it or needed help/);
    expect(out.today[1]!.reason).toBe("Due 9 days ago.");
  });

  it("offers nothing on or after the exam date", () => {
    const items = [item("a", { nextDueAt: day("2026-02-01") })];
    expect(dueItems(items, now, TZ, "2026-02-10", POLICY_V1).today).toEqual([]);
    expect(dueItems(items, now, TZ, "2026-02-11", POLICY_V1).today).toHaveLength(1);
  });

  it("after 10 missed days, caps the queue and drains the backlog over following days", () => {
    const policy = { ...POLICY_V1, maxReviewsPerDay: 20 };
    // 100 questions were all due before 10 missed days.
    const items = Array.from({ length: 100 }, (_, i) =>
      item(`q${String(i).padStart(3, "0")}`, { nextDueAt: day("2026-02-01") }),
    );
    let remaining = items;
    const sizes: number[] = [];
    const seen = new Set<string>();
    for (let d = 0; d < 6 && remaining.length; d++) {
      const today = addDays("2026-02-11", d);
      const out = dueItems(remaining, at(`${today}T20:00:00Z`), TZ, null, policy);
      sizes.push(out.today.length);
      expect(out.today.length + out.deferred.length).toBe(remaining.length);
      for (const i of out.today) {
        expect(seen.has(i.questionId)).toBe(false);
        seen.add(i.questionId);
      }
      // Reviewed items leave the queue; the deferred ones keep their place and are not failed.
      const done = new Set(out.today.map((i) => i.questionId));
      remaining = remaining.filter((i) => !done.has(i.questionId));
      expect(remaining.every((i) => i.lapses === 0 && i.state === "reviewing")).toBe(true);
    }
    expect(sizes).toEqual([20, 20, 20, 20, 20]);
    expect(remaining).toHaveLength(0);
  });

  it("respects a smaller cap and a user in another timezone", () => {
    // Due on the morning of Feb 11 in Vancouver time terms, i.e. after Vancouver's Feb 10 ends
    // but before Sydney's Feb 11 ends.
    const sydney = at("2026-02-11T10:00:00Z");
    const one = { ...POLICY_V1, maxReviewsPerDay: 1 };
    const items = [item("a", { nextDueAt: sydney }), item("b", { nextDueAt: sydney })];
    // 2026-02-10T20:00Z is already Feb 11 in Sydney, where both are due; in Vancouver it is
    // still Feb 10, so neither is.
    const syd = dueItems(items, now, "Australia/Sydney", null, one);
    expect(syd.today).toHaveLength(1);
    expect(syd.deferred).toHaveLength(1);
    expect(dueItems(items, now, TZ, null, one).today).toEqual([]);
  });
});
