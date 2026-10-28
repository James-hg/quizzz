import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentToRevision } from "@/lib/schemas";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { getDb } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { addRevision } from "@/server/db/repositories/questions";
import {
  questionImages,
  questionRevisionImages,
  questions,
  studySessions,
} from "@/server/db/schema";
import { LocalStorageAdapter } from "@/server/storage/local";
import { JPEG_BYTES, PNG_BYTES, SVG_BYTES } from "@/test/images";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import {
  createImage,
  deleteUnlinkedImages,
  getOwnedImage,
  loadImagesForRevisions,
  purgeOrphanImages,
} from "./service";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
const MAX = 2 * 1024 * 1024;
let dir: string;
let storage: LocalStorageAdapter;
let alice: TestUser;
let bob: TestUser;
let courseId: string;
let setId: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "quizzz-images-"));
  storage = new LocalStorageAdapter(dir);
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  courseId = (await createCourse(db, alice.id, { title: "C", subject: "S" })).id;
  setId = (await createQuestionSet(db, alice.id, courseId, "Images")).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
  await rm(dir, { recursive: true, force: true });
});

async function revision(prompt: string) {
  const [question] = await db
    .insert(questions)
    .values({ questionSetId: setId, position: 0 })
    .returning();
  const content = contentToRevision({
    type: "mcq_single",
    prompt,
    options: [
      { id: "a", text: "x" },
      { id: "b", text: "y" },
    ],
    correctOptionIds: ["a"],
  });
  const rev = await addRevision(db, question!.id, {
    ...content,
    origin: "original",
    evidenceStatus: "human_reviewed",
    createdBy: alice.id,
  });
  return { question: question!, revision: rev };
}

describe("createImage", () => {
  it("stores the bytes privately and records the detected type, size and hash", async () => {
    const image = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    expect(image).toMatchObject({
      ownerId: alice.id,
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length,
    });
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(image.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    expect(new Uint8Array(await storage.get(image.storageKey))).toEqual(PNG_BYTES);
  });

  it("refuses SVG and oversized files without storing anything", async () => {
    const before = await db
      .select()
      .from(questionImages)
      .where(eq(questionImages.ownerId, alice.id));
    await expect(createImage(db, storage, alice.id, SVG_BYTES, MAX)).rejects.toMatchObject({
      code: "unsupported_image",
    });
    await expect(createImage(db, storage, alice.id, PNG_BYTES, 10)).rejects.toMatchObject({
      code: "image_too_large",
    });
    const after = await db
      .select()
      .from(questionImages)
      .where(eq(questionImages.ownerId, alice.id));
    expect(after).toHaveLength(before.length);
  });
});

describe("getOwnedImage", () => {
  it("returns the owner's image and treats another user's as missing", async () => {
    const image = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    await expect(getOwnedImage(db, alice.id, image.id)).resolves.toMatchObject({ id: image.id });
    await expect(getOwnedImage(db, bob.id, image.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      getOwnedImage(db, alice.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("links and cleanup", () => {
  it("loads what each revision shows, and nothing for revisions without an image", async () => {
    const image = await createImage(db, storage, alice.id, JPEG_BYTES, MAX);
    const withImage = await revision("With");
    const without = await revision("Without");
    await db.insert(questionRevisionImages).values({
      questionRevisionId: withImage.revision.id,
      imageId: image.id,
      altText: "A diagram",
    });
    const map = await loadImagesForRevisions(db, [withImage.revision.id, without.revision.id]);
    expect(map.get(withImage.revision.id)).toEqual({
      id: image.id,
      url: `/api/images/${image.id}`,
      alt: "A diagram",
    });
    expect(map.has(without.revision.id)).toBe(false);
    expect((await loadImagesForRevisions(db, [])).size).toBe(0);
  });

  it("deleteUnlinkedImages removes unlinked images and their bytes, and keeps linked ones", async () => {
    const linked = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    const loose = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    const rev = await revision("Linked");
    await db.insert(questionRevisionImages).values({
      questionRevisionId: rev.revision.id,
      imageId: linked.id,
      altText: "Kept",
    });

    expect(await deleteUnlinkedImages(db, storage, [linked.id, loose.id])).toBe(1);
    expect(await storage.exists(loose.storageKey)).toBe(false);
    expect(await storage.exists(linked.storageKey)).toBe(true);
    await expect(getOwnedImage(db, alice.id, loose.id)).rejects.toMatchObject({ status: 404 });
    await expect(getOwnedImage(db, alice.id, linked.id)).resolves.toBeTruthy();
  });

  it("purgeOrphanImages only removes old images that nothing links to", async () => {
    const fresh = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    const old = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    await db
      .update(questionImages)
      .set({ createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) })
      .where(eq(questionImages.id, old.id));
    const removed = await purgeOrphanImages(db, storage, 24 * 3600 * 1000);
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(getOwnedImage(db, alice.id, old.id)).rejects.toMatchObject({ status: 404 });
    await expect(getOwnedImage(db, alice.id, fresh.id)).resolves.toBeTruthy();
  });
});

describe("migration 0007: a revision's image is frozen once attempts exist", () => {
  it("lets an unattempted link change, then blocks changing or deleting it after an attempt", async () => {
    const first = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    const second = await createImage(db, storage, alice.id, JPEG_BYTES, MAX);
    const { question, revision: rev } = await revision("Frozen");
    await db.insert(questionRevisionImages).values({
      questionRevisionId: rev.id,
      imageId: first.id,
      altText: "Before",
    });
    // No attempt yet: editing the link is allowed.
    await db
      .update(questionRevisionImages)
      .set({ altText: "Still editable" })
      .where(eq(questionRevisionImages.questionRevisionId, rev.id));

    const [session] = await db
      .insert(studySessions)
      .values({ userId: alice.id, courseId, questionSetId: setId, mode: "quiz" })
      .returning();
    await insertAttempt(db, {
      sessionId: session!.id,
      userId: alice.id,
      questionId: question.id,
      questionRevisionId: rev.id,
      response: { kind: "options", selectedOptionIds: ["a"] },
      isCorrect: true,
      gradingOutcome: "correct",
      idempotencyKey: "images-frozen-0001",
      startedAt: new Date(),
    });

    await expect(
      db
        .update(questionRevisionImages)
        .set({ imageId: second.id })
        .where(eq(questionRevisionImages.questionRevisionId, rev.id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/cannot change/) } });
    await expect(
      db
        .update(questionRevisionImages)
        .set({ altText: "Rewritten" })
        .where(eq(questionRevisionImages.questionRevisionId, rev.id)),
    ).rejects.toBeTruthy();
    await expect(
      db
        .delete(questionRevisionImages)
        .where(eq(questionRevisionImages.questionRevisionId, rev.id)),
    ).rejects.toBeTruthy();

    const [stored] = await db
      .select()
      .from(questionRevisionImages)
      .where(eq(questionRevisionImages.questionRevisionId, rev.id));
    expect(stored).toMatchObject({ imageId: first.id, altText: "Still editable" });
  });

  it("rejects empty or over-long alt text at the database", async () => {
    const image = await createImage(db, storage, alice.id, PNG_BYTES, MAX);
    const rev = await revision("Alt check");
    await expect(
      db.insert(questionRevisionImages).values({
        questionRevisionId: rev.revision.id,
        imageId: image.id,
        altText: "",
      }),
    ).rejects.toBeTruthy();
    await expect(
      db.insert(questionRevisionImages).values({
        questionRevisionId: rev.revision.id,
        imageId: image.id,
        altText: "x".repeat(301),
      }),
    ).rejects.toBeTruthy();
  });
});
