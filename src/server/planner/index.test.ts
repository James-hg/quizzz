import { describe, expect, it } from "vitest";
import {
  capacityFor,
  estimateSecondsPerItem,
  median,
  planSession,
  PLANNER_V1,
  type Candidate,
} from "./index";

const id = (prefix: string, i: number) => `${prefix}-${String(i).padStart(3, "0")}`;

function due(i: number, over: Partial<Candidate> = {}, overdue = 0, relearning = false): Candidate {
  return {
    questionId: id("due", i),
    revisionId: `rev-${id("due", i)}`,
    questionSetId: "set-a",
    questionSetTitle: "Set A",
    position: i,
    due: { reason: "Due today.", daysOverdue: overdue, relearning },
    scoredAttempts: 2,
    lastFirstTryMissed: false,
    ...over,
  };
}

function fresh(i: number, over: Partial<Candidate> = {}): Candidate {
  return {
    questionId: id("new", i),
    revisionId: `rev-${id("new", i)}`,
    questionSetId: "set-a",
    questionSetTitle: "Set A",
    position: 100 + i,
    due: null,
    scoredAttempts: 0,
    lastFirstTryMissed: false,
    ...over,
  };
}

function seen(i: number, over: Partial<Candidate> = {}): Candidate {
  return fresh(i, {
    questionId: id("seen", i),
    revisionId: `rev-${id("seen", i)}`,
    scoredAttempts: 3,
    ...over,
  });
}

const plan = (
  candidates: Candidate[],
  over: { budget?: 5 | 10 | 20; mode?: "review" | "exam"; secs?: number } = {},
) =>
  planSession({
    candidates,
    mode: over.mode ?? "review",
    budgetMinutes: over.budget ?? 5,
    estimatedSecondsPerItem: over.secs ?? 120,
  });

describe("capacity and estimates", () => {
  it("fits whole questions into the budget, and at least one", () => {
    expect(capacityFor(5, 120)).toBe(2);
    expect(capacityFor(10, 120)).toBe(5);
    expect(capacityFor(20, 120)).toBe(10);
    expect(capacityFor(5, 600)).toBe(1);
    expect(capacityFor(1, 600)).toBe(1);
  });

  it("uses a conservative default until there is enough history", () => {
    expect(estimateSecondsPerItem([])).toBe(PLANNER_V1.defaultSecondsPerItem);
    expect(estimateSecondsPerItem([30, 40])).toBe(120);
  });

  it("then uses the median pace, ignoring junk and clamping extremes", () => {
    expect(estimateSecondsPerItem([40, 50, 60])).toBe(50);
    expect(estimateSecondsPerItem([40, 50, 60, 70])).toBe(55);
    expect(estimateSecondsPerItem([40, NaN, -5, 0, 50, 60, Infinity])).toBe(50);
    expect(estimateSecondsPerItem([2, 3, 4])).toBe(PLANNER_V1.minSecondsPerItem);
    expect(estimateSecondsPerItem([5000, 6000, 7000])).toBe(PLANNER_V1.maxSecondsPerItem);
  });

  it("computes a median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("review mode", () => {
  it("a 5-minute session with 50 due questions includes only what fits, with a reason", () => {
    const candidates = Array.from({ length: 50 }, (_, i) => due(i, {}, 50 - i));
    const p = plan(candidates);
    expect(p.items).toHaveLength(2);
    expect(p.estimatedSeconds).toBe(240);
    expect(p.limitedBy).toBe("budget");
    expect(p.reasons[0]).toBe(
      "2 of your 50 due questions fit in 5 minutes (about 120 seconds each). The other 48 stay due and come back next time.",
    );
    // The longest overdue come first.
    expect(p.items.map((i) => i.questionId)).toEqual(["due-000", "due-001"]);
  });

  it("never claims that everything that is due fits", () => {
    const p = plan(
      Array.from({ length: 50 }, (_, i) => due(i)),
      { budget: 20 },
    );
    expect(p.items.length).toBeLessThan(50);
    expect(p.reasons.join(" ")).not.toMatch(/all 50|everything/i);
  });

  it("keeps at least one new-learning slot when new questions exist", () => {
    const candidates = [...Array.from({ length: 50 }, (_, i) => due(i)), fresh(1), fresh(2)];
    const p = plan(candidates, { budget: 10 }); // capacity 5, 25% => 1 slot
    expect(p.counts).toMatchObject({ due: 4, new: 1 });
    expect(p.items.filter((i) => i.questionId.startsWith("new"))).toHaveLength(1);
    expect(p.reasons.join(" ")).toMatch(
      /kept for new questions so reviews do not crowd out new learning/,
    );
  });

  it("scales the new-learning share with the budget", () => {
    const candidates = [
      ...Array.from({ length: 50 }, (_, i) => due(i)),
      ...Array.from({ length: 20 }, (_, i) => fresh(i)),
    ];
    const p = plan(candidates, { budget: 20 }); // capacity 10 => floor(2.5) = 2 slots
    expect(p.counts).toMatchObject({ due: 8, new: 2 });
  });

  it("does not hold a new slot when the budget fits a single question", () => {
    const p = plan([due(1), due(2), fresh(1)], { budget: 5, secs: 600 }); // capacity 1
    expect(p.items.map((i) => i.questionId)).toEqual(["due-001"]);
  });

  it("gives unused due slots to new questions", () => {
    const p = plan([due(1), fresh(1), fresh(2), fresh(3)], { budget: 10 });
    expect(p.counts).toMatchObject({ due: 1, new: 3 });
    expect(p.items.map((i) => i.questionId)).toEqual(["due-001", "new-001", "new-002", "new-003"]);
    expect(p.limitedBy).toBe("content");
    expect(p.reasons.join(" ")).toMatch(/Only 4 questions can be practised right now/);
  });

  it("works with no new questions", () => {
    const p = plan(
      Array.from({ length: 6 }, (_, i) => due(i)),
      { budget: 10 },
    );
    expect(p.counts).toMatchObject({ due: 5, new: 0 });
    expect(p.items).toHaveLength(5);
  });

  it("works with nothing due, filling with new questions and then extra practice", () => {
    const p = plan([fresh(1), seen(1, { lastFirstTryMissed: true }), seen(2)], { budget: 10 });
    expect(p.reasons[0]).toBe("Nothing is due for review today.");
    expect(p.items.map((i) => i.questionId)).toEqual(["new-001", "seen-001", "seen-002"]);
    expect(p.reasons.join(" ")).toMatch(/starting with ones you missed/);
  });

  it("returns an honest empty plan when nothing is playable", () => {
    const p = plan([]);
    expect(p.items).toEqual([]);
    expect(p.estimatedSeconds).toBe(0);
    expect(p.reasons).toEqual(["There are no playable questions in this course yet."]);
  });

  it("orders due questions: relearning first, then most overdue, then by id", () => {
    const p = plan(
      [due(3, {}, 1), due(1, {}, 9), due(2, {}, 1, true), due(5, {}, 1), due(4, {}, 1)],
      { budget: 20 },
    );
    expect(p.items.map((i) => i.questionId)).toEqual([
      "due-002",
      "due-001",
      "due-003",
      "due-004",
      "due-005",
    ]);
  });

  it("is stable: the same input gives the same plan whatever order it arrives in", () => {
    const candidates = [due(1, {}, 3), due(2, {}, 3), fresh(1), fresh(2), seen(1), seen(2)];
    const a = plan(candidates, { budget: 10 });
    const b = plan([...candidates].reverse(), { budget: 10 });
    expect(b.items).toEqual(a.items);
    expect(b.reasons).toEqual(a.reasons);
  });

  it("never repeats a question", () => {
    const p = plan([due(1), due(1), fresh(1), fresh(1), seen(1)], { budget: 20 });
    expect(new Set(p.items.map((i) => i.questionId)).size).toBe(p.items.length);
    expect(p.items).toHaveLength(3);
  });

  it("reports content as the limit only when the budget was not the cause", () => {
    expect(plan([due(1), due(2)], { budget: 5 }).limitedBy).toBeNull();
    expect(plan([due(1)], { budget: 5 }).limitedBy).toBe("content");
    expect(plan([due(1), due(2), due(3)], { budget: 5 }).limitedBy).toBe("budget");
  });

  it("uses the student's own pace once it is known", () => {
    const slow = plan(
      Array.from({ length: 30 }, (_, i) => due(i)),
      { budget: 10, secs: 300 },
    );
    const quick = plan(
      Array.from({ length: 30 }, (_, i) => due(i)),
      { budget: 10, secs: 60 },
    );
    expect(slow.items).toHaveLength(2);
    expect(quick.items).toHaveLength(10);
    expect(quick.reasons[0]).toMatch(/about 60 seconds each/);
  });

  it("reports the revision to pin for every item", () => {
    const p = plan([due(1)], { budget: 5 });
    expect(p.items[0]).toEqual({ questionId: "due-001", revisionId: "rev-due-001" });
  });
});

describe("exam mode", () => {
  const sets = (setId: string, title: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      fresh(i, {
        questionId: `${setId}-${i}`,
        revisionId: `rev-${setId}-${i}`,
        questionSetId: setId,
        questionSetTitle: title,
        position: i,
        due: i === 0 ? { reason: "Due", daysOverdue: 5, relearning: true } : null,
      }),
    );

  it("spreads questions across question sets and ignores due state", () => {
    const p = plan(
      [...sets("s1", "Alpha", 6), ...sets("s2", "Beta", 6), ...sets("s3", "Gamma", 6)],
      {
        mode: "exam",
        budget: 20,
      },
    );
    expect(p.items.map((i) => i.questionId)).toEqual([
      "s1-0",
      "s2-0",
      "s3-0",
      "s1-1",
      "s2-1",
      "s3-1",
      "s1-2",
      "s2-2",
      "s3-2",
      "s1-3",
    ]);
    expect(p.reasons[0]).toMatch(/Practice exam: 10 questions from 3 question sets/);
    expect(p.reasons[0]).toMatch(/No hints, and results only at the end/);
    expect(p.reasons[0]).toMatch(/not an official assessment/);
    expect(p.counts).toMatchObject({ due: 0, new: 0 });
  });

  it("reports the budget as the limit, and the content when it runs out", () => {
    const many = plan(sets("s1", "Alpha", 30), { mode: "exam", budget: 5 });
    expect(many.items).toHaveLength(2);
    expect(many.limitedBy).toBe("budget");
    expect(many.reasons.join(" ")).toMatch(/2 of 30 questions fit in 5 minutes/);
    const few = plan(sets("s1", "Alpha", 3), { mode: "exam", budget: 20 });
    expect(few.items).toHaveLength(3);
    expect(few.limitedBy).toBe("content");
  });

  it("handles one set, and no questions", () => {
    expect(plan(sets("s1", "Alpha", 1), { mode: "exam" }).items).toHaveLength(1);
    expect(plan([], { mode: "exam" }).items).toEqual([]);
  });

  it("is stable regardless of input order", () => {
    const all = [...sets("s1", "Alpha", 4), ...sets("s2", "Beta", 4)];
    expect(plan([...all].reverse(), { mode: "exam", budget: 10 }).items).toEqual(
      plan(all, { mode: "exam", budget: 10 }).items,
    );
  });
});
