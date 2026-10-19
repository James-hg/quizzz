import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as importPost } from "@/app/api/courses/[courseId]/imports/route";
import { POST as coursesPost } from "@/app/api/courses/route";
import { PATCH as itemPatch } from "@/app/api/imports/[importId]/items/[itemId]/route";
import { POST as publishPost } from "@/app/api/imports/[importId]/publish/route";
import { GET as importGet } from "@/app/api/imports/[importId]/route";
import { GET as formatsGet } from "@/app/api/import/formats/route";
import { POST as answerPost } from "@/app/api/sessions/[sessionId]/answers/route";
import { POST as completePost } from "@/app/api/sessions/[sessionId]/complete/route";
import { GET as sessionGet } from "@/app/api/sessions/[sessionId]/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { getDb } from "@/server/db";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
let user: TestUser;

beforeAll(async () => {
  user = await signUpUser(db);
});
afterAll(async () => {
  await deleteUsers(db, [user.id]);
});

function uploadRequest(courseId: string, filename: string, bytes: Buffer) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename));
  return importPost(
    new Request(`http://localhost:3000/api/courses/${courseId}/imports`, {
      method: "POST",
      headers: { cookie: user.cookie, origin: "http://localhost:3000" },
      body: form,
    }),
    { params: Promise.resolve({ courseId }) },
  );
}

/**
 * The student journey the UI drives, at the HTTP-handler level: sign up, create a course,
 * import a DOCX, fix the flagged question, publish, practise, resume, and finish.
 */
describe("main student journey", () => {
  it("runs from import to a finished session without ever exposing answer keys early", async () => {
    // The upload picker is driven by this endpoint.
    const formats = await call(formatsGet, "/api/import/formats", user);
    expect(formats.body.formats).toEqual([
      { extension: "docx", label: expect.stringContaining("docx") },
    ]);

    const course = (
      await call(coursesPost, "/api/courses", user, {
        body: { title: "CMPT 120", subject: "Intro programming", language: "python" },
      })
    ).body.course;

    // Import the partial-bold fixture: the answer is ambiguous, so it is flagged and unresolved.
    const bytes = readFileSync(join(process.cwd(), "fixtures", "docx", "partial-bold.docx"));
    const uploaded = await uploadRequest(course.id, "partial-bold.docx", bytes);
    expect(uploaded.status).toBe(201);
    const draft = (await uploaded.json()).import;
    const item = draft.items[0];
    expect(item.payload.correctOptionIds).toEqual([]);
    expect(item.warnings.map((w: { code: string }) => w.code)).toContain("answer_unresolved");

    // Fix it in review: choose the answer and accept.
    const eight = item.payload.options.find((o: { text: string }) => o.text.endsWith("8"));
    const fixed = await call(itemPatch, "/api/x", user, {
      method: "PATCH",
      body: { edit: { correctOptionIds: [eight.id] }, decision: "accepted" },
      params: { importId: draft.id, itemId: item.id },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.import.items[0].decision).toBe("edited");

    const published = await call(publishPost, "/api/x", user, {
      body: { title: "Imported quiz" },
      params: { importId: draft.id },
    });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ published: 1, unresolved: 0 });
    const setId = published.body.questionSetId as string;

    // The draft now reads as published.
    const reread = await call(importGet, "/api/x", user, { params: { importId: draft.id } });
    expect(reread.body.import.status).toBe("published");

    // Practise. The session payload carries no key before submission.
    const started = await call(sessionsPost, "/api/sessions", user, {
      body: { questionSetId: setId, mode: "quiz" },
    });
    expect(started.status).toBe(201);
    expect(started.text).not.toMatch(/correctOptionIds|answerKey|isCorrect/);
    const sessionId = started.body.session.id as string;

    // "Reload": fetching the session again resumes at the same question.
    const reloaded = await call(sessionGet, "/api/x", user, { params: { sessionId } });
    expect(reloaded.body.session.current.questionId).toBe(started.body.session.current.questionId);
    expect(reloaded.text).not.toMatch(/correctOptionIds|answerKey|isCorrect/);

    const answered = await call(answerPost, "/api/x", user, {
      body: {
        questionId: started.body.session.current.questionId,
        response: { kind: "options", selectedOptionIds: [eight.id] },
        idempotencyKey: "journey-key-0001",
      },
      params: { sessionId },
    });
    expect(answered.body.result).toMatchObject({ outcome: "correct", isCorrect: true });

    const done = await call(completePost, "/api/x", user, {
      method: "POST",
      params: { sessionId },
    });
    expect(done.body.summary).toMatchObject({ answered: 1, correct: 1, unanswered: 0 });
  });

  it("rejects a file type that is not supported with a clear code", async () => {
    const course = (
      await call(coursesPost, "/api/courses", user, {
        body: { title: "Other", subject: "x" },
      })
    ).body.course;
    const res = await uploadRequest(course.id, "notes.pdf", Buffer.from("%PDF-1.4 not really"));
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe("unsupported_format");
  });
});
