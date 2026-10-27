import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-numbers-"));
process.env.STORAGE_DIR = storageDir;
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { POST as uploadPost } from "@/app/api/courses/[courseId]/imports/route";
import { GET as importGet } from "@/app/api/imports/[importId]/route";
import { PATCH as itemPatch } from "@/app/api/imports/[importId]/items/[itemId]/route";
import { POST as publishPost } from "@/app/api/imports/[importId]/publish/route";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "@/server/content/courses";
import { getDb } from "@/server/db";
import { questionRevisions, questions } from "@/server/db/schema";
import { clearDetectors } from "./detectors";
import { clearExtractors } from "@/server/extract/registry";

const db = getDb();
let alice: TestUser;
let courseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
});
beforeEach(async () => {
  clearExtractors();
  clearDetectors();
  courseId = (await createCourse(db, alice.id, { title: `C ${Math.random()}`, subject: "CS" })).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id]);
  await rm(storageDir, { recursive: true, force: true });
});

type Item = {
  id: string;
  decision: string;
  payload: { prompt: string; originalPrompt?: string | null };
};

async function upload() {
  const bytes = await readFile(path.join(process.cwd(), "fixtures/docx/typed-numbers.docx"));
  const form = new FormData();
  form.set("file", new File([bytes], "typed-numbers.docx"));
  const response = await uploadPost(
    new Request("http://localhost:3000/x", {
      method: "POST",
      headers: { cookie: alice.cookie, origin: "http://localhost:3000" },
      body: form,
    }),
    { params: Promise.resolve({ courseId }) },
  );
  expect(response.status).toBe(201);
  return (await response.json()).import as { id: string; items: Item[] };
}

async function call(
  handler: unknown,
  body: unknown,
  params: Record<string, string>,
  method = "PATCH",
) {
  const response = await (
    handler as (r: Request, c: { params: Promise<never> }) => Promise<Response>
  )(authRequest("/x", { method, body, cookie: alice.cookie }), {
    params: Promise.resolve(params as never),
  });
  return { status: response.status, body: await response.json() };
}

const patch = (importId: string, itemId: string, body: unknown) =>
  call(itemPatch, body, { importId, itemId });

describe("question number toggle through the item edit endpoint", () => {
  it("round-trips the exact original and leaves a pending item pending", async () => {
    const draft = await upload();
    const item = draft.items[0]!;
    expect(item.decision).toBe("pending");
    const original = item.payload.originalPrompt!;
    expect(original).toBe("1. What does len([1, 2]) return?");

    const restored = await patch(draft.id, item.id, {
      edit: { prompt: original, originalPrompt: null },
      decision: "pending",
    });
    expect(restored.status).toBe(200);
    const afterRestore = restored.body.import.items[0] as Item;
    expect(afterRestore.decision).toBe("pending");
    expect(afterRestore.payload.prompt).toBe(original);
    expect(afterRestore.payload.originalPrompt ?? null).toBeNull();

    const reapplied = await patch(draft.id, item.id, {
      edit: { prompt: item.payload.prompt, originalPrompt: original },
      decision: "pending",
    });
    const afterReapply = reapplied.body.import.items[0] as Item;
    expect(afterReapply.decision).toBe("pending");
    expect(afterReapply.payload).toMatchObject({
      prompt: "What does len([1, 2]) return?",
      originalPrompt: original,
    });
  });

  it("keeps accepted items accepted and excluded items excluded when toggling", async () => {
    const draft = await upload();
    const [accepted, excluded] = draft.items;
    await patch(draft.id, accepted!.id, { decision: "accepted" });
    await patch(draft.id, excluded!.id, { decision: "excluded" });

    const a = await patch(draft.id, accepted!.id, {
      edit: { prompt: accepted!.payload.originalPrompt, originalPrompt: null },
      decision: "accepted",
    });
    expect((a.body.import.items[0] as Item).decision).toBe("edited");

    const e = await patch(draft.id, excluded!.id, {
      edit: { prompt: excluded!.payload.originalPrompt, originalPrompt: null },
      decision: "excluded",
    });
    expect((e.body.import.items[1] as Item).decision).toBe("excluded");
  });

  it("publishes exactly the text the review page showed", async () => {
    const draft = await upload();
    // Restore the number on the first question, keep it removed on the others, accept all.
    await patch(draft.id, draft.items[0]!.id, {
      edit: { prompt: draft.items[0]!.payload.originalPrompt, originalPrompt: null },
      decision: "accepted",
    });
    for (const item of draft.items.slice(1)) {
      await patch(draft.id, item.id, { decision: "accepted" });
    }

    const shown = (await call(importGet, undefined, { importId: draft.id }, "GET")).body.import
      .items as Item[];
    const published = await call(publishPost, { title: "Numbers" }, { importId: draft.id }, "POST");
    expect(published.status).toBe(201);

    const rows = await db
      .select({ q: questions, r: questionRevisions })
      .from(questions)
      .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
      .where(eq(questions.questionSetId, published.body.questionSetId));
    const stored = rows.sort((a, b) => a.q.position - b.q.position).map((row) => row.r.prompt);
    expect(stored).toEqual(shown.map((i) => i.payload.prompt));
    expect(stored).toEqual([
      "1. What does len([1, 2]) return?",
      "Which keyword defines a function in Python?",
      "Which loop always runs at least once?",
      "2 + 2 = ?",
    ]);
  });

  it("rejects an oversized remembered original", async () => {
    const draft = await upload();
    const res = await patch(draft.id, draft.items[0]!.id, {
      edit: { prompt: "x", originalPrompt: "y".repeat(10_001) },
    });
    expect(res.status).toBe(400);
  });
});
