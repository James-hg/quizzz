import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-question-images-"));
process.env.STORAGE_DIR = storageDir;
process.env.MAX_IMAGE_BYTES = "4000";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { GET as imageGet } from "@/app/api/images/[imageId]/route";
import { POST as uploadPost } from "@/app/api/question-sets/[setId]/images/route";
import { POST as questionsPost } from "@/app/api/question-sets/[setId]/questions/route";
import { POST as shufflePost } from "@/app/api/questions/[questionId]/shuffle-options/route";
import {
  DELETE as questionDelete,
  GET as questionGet,
  PATCH as questionPatch,
} from "@/app/api/questions/[questionId]/route";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { getSession, startOrResumeSession } from "@/server/sessions/service";
import { getDb } from "@/server/db";
import { questionImages, questionRevisionImages, questionRevisions } from "@/server/db/schema";
import { call } from "@/test/api";
import { authRequest } from "@/test/auth-helpers";
import { GIF_BYTES, JPEG_BYTES, PNG_BYTES, SVG_BYTES } from "@/test/images";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { MAX_STAGED_IMAGES } from "./service";

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let setId: string;
let bobSetId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  const course = await createCourse(db, alice.id, { title: "C", subject: "S" });
  setId = (await createQuestionSet(db, alice.id, course.id, "Images")).id;
  const bobCourse = await createCourse(db, bob.id, { title: "B", subject: "S" });
  bobSetId = (await createQuestionSet(db, bob.id, bobCourse.id, "Bob")).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
  await rm(storageDir, { recursive: true, force: true });
});

function multipart(
  user: TestUser | null,
  bytes: Uint8Array,
  filename = "photo.png",
  type = "image/png",
) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename, { type }));
  const headers: Record<string, string> = { origin: "http://localhost:3000" };
  if (user) headers.cookie = user.cookie;
  return new Request("http://localhost:3000/x", { method: "POST", headers, body: form });
}

async function upload(
  user: TestUser | null,
  set: string,
  bytes: Uint8Array,
  name?: string,
  type?: string,
) {
  const response = await uploadPost(multipart(user, bytes, name, type), {
    params: Promise.resolve({ setId: set }),
  });
  return { status: response.status, body: await response.json() };
}

async function fetchImage(user: TestUser | null, id: string, headers: Record<string, string> = {}) {
  const request = authRequest(`/api/images/${id}`, { cookie: user?.cookie });
  for (const [k, v] of Object.entries(headers)) request.headers.set(k, v);
  return imageGet(request, { params: Promise.resolve({ imageId: id }) });
}

const mcq = (extra: Record<string, unknown> = {}) => ({
  type: "mcq_single",
  prompt: "What is shown?",
  options: [
    { id: "a", text: "A cat" },
    { id: "b", text: "A dog" },
  ],
  correctOptionIds: ["a"],
  ...extra,
});

async function stage(user: TestUser = alice, set = setId, bytes: Uint8Array = PNG_BYTES) {
  const res = await upload(user, set, bytes);
  expect(res.status).toBe(201);
  return res.body.image.id as string;
}

async function create(extra: Record<string, unknown> = {}) {
  const res = await call(questionsPost, "/x", alice, { body: mcq(extra), params: { setId } });
  return res;
}

const patch = (id: string, body: unknown) =>
  call(questionPatch, "/x", alice, { method: "PATCH", body, params: { questionId: id } });

async function linkOf(revisionId: string) {
  const [row] = await db
    .select()
    .from(questionRevisionImages)
    .where(eq(questionRevisionImages.questionRevisionId, revisionId));
  return row;
}

describe("uploading", () => {
  it("stores a PNG, JPEG, and returns an id and an authenticated URL", async () => {
    const png = await upload(alice, setId, PNG_BYTES);
    expect(png.body.image).toMatchObject({ mimeType: "image/png", sizeBytes: PNG_BYTES.length });
    expect(png.body.image.url).toBe(`/api/images/${png.body.image.id}`);
    expect(png.body.image).not.toHaveProperty("storageKey");
    const jpeg = await upload(alice, setId, JPEG_BYTES, "x.jpg", "image/jpeg");
    expect(jpeg.body.image.mimeType).toBe("image/jpeg");
  });

  it("ignores the file name and claimed type: only the bytes decide", async () => {
    const res = await upload(alice, setId, PNG_BYTES, "evil.exe", "application/x-msdownload");
    expect(res.status).toBe(201);
    expect(res.body.image.mimeType).toBe("image/png");
    const fake = await upload(
      alice,
      setId,
      new Uint8Array(Buffer.from("not an image")),
      "a.png",
      "image/png",
    );
    expect(fake.status).toBe(415);
  });

  it.each([
    ["SVG", SVG_BYTES, "a.svg", "image/svg+xml"],
    ["GIF", GIF_BYTES, "a.gif", "image/gif"],
  ])("rejects %s with a clear message", async (_n, bytes, name, type) => {
    const res = await upload(alice, setId, bytes, name, type);
    expect(res.status).toBe(415);
    expect(res.body.error).toMatchObject({
      code: "unsupported_image",
      message: "Only PNG, JPEG or WebP images are supported.",
    });
  });

  it("rejects an oversized image and states the limit", async () => {
    const big = new Uint8Array(6000);
    big.set(PNG_BYTES);
    const res = await upload(alice, setId, big);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: "image_too_large" });
    expect(res.body.error.message).toBe("This image is too large. The maximum size is 4 KB.");
  });

  it("rejects an empty file", async () => {
    expect((await upload(alice, setId, new Uint8Array())).status).toBe(422);
  });

  it("needs a session, and a question set the user owns", async () => {
    expect((await upload(null, setId, PNG_BYTES)).status).toBe(401);
    expect((await upload(alice, bobSetId, PNG_BYTES)).status).toBe(404);
    expect((await upload(bob, setId, PNG_BYTES)).status).toBe(404);
  });

  it("limits how many unattached images one user can hold", async () => {
    const holder = await signUpUser(db);
    const course = await createCourse(db, holder.id, { title: "H", subject: "S" });
    const set = (await createQuestionSet(db, holder.id, course.id, "Hold")).id;
    try {
      for (let i = 0; i < MAX_STAGED_IMAGES; i++) {
        expect((await upload(holder, set, PNG_BYTES)).status).toBe(201);
      }
      const over = await upload(holder, set, PNG_BYTES);
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe("too_many_staged_images");
    } finally {
      await deleteUsers(db, [holder.id]);
    }
  });
});

describe("serving images", () => {
  it("serves the owner's image with safe headers", async () => {
    const id = await stage();
    const res = await fetchImage(alice, id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  it("revalidates with the ETag instead of resending the bytes", async () => {
    const id = await stage();
    const first = await fetchImage(alice, id);
    const etag = first.headers.get("etag")!;
    const again = await fetchImage(alice, id, { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("is not reachable without a session, or by another user", async () => {
    const id = await stage();
    expect((await fetchImage(null, id)).status).toBe(401);
    const other = await fetchImage(bob, id);
    const missing = await fetchImage(bob, "00000000-0000-4000-8000-000000000000");
    expect(other.status).toBe(404);
    // An image that exists but is not yours looks the same as one that does not exist.
    expect(await other.json()).toEqual(await missing.json());
    expect((await fetchImage(alice, "not-a-uuid")).status).toBe(404);
  });

  it("stays private after it is attached to a question", async () => {
    const id = await stage();
    const created = await create({ image: { imageId: id, alt: "A cat on a sofa" } });
    expect(created.status).toBe(201);
    expect((await fetchImage(null, id)).status).toBe(401);
    expect((await fetchImage(bob, id)).status).toBe(404);
    expect((await fetchImage(alice, id)).status).toBe(200);
  });
});

describe("attaching an image to a question", () => {
  it("shows it, with its alt text, in the owner's view", async () => {
    const id = await stage();
    const created = await create({ image: { imageId: id, alt: "  A cat on a sofa  " } });
    expect(created.body.question.image).toEqual({
      id,
      url: `/api/images/${id}`,
      alt: "A cat on a sofa",
    });
    const read = await call(questionGet, "/x", alice, {
      params: { questionId: created.body.question.id },
    });
    expect(read.body.question.image).toMatchObject({ id, alt: "A cat on a sofa" });
  });

  it("requires alt text, and refuses images that are not yours or do not exist", async () => {
    const id = await stage();
    expect((await create({ image: { imageId: id, alt: "" } })).status).toBe(400);
    expect((await create({ image: { imageId: id, alt: "   " } })).status).toBe(400);
    expect((await create({ image: { imageId: id, alt: "x".repeat(301) } })).status).toBe(400);
    expect((await create({ image: { imageId: id } })).status).toBe(400);

    const bobsImage = await stage(bob, bobSetId);
    expect((await create({ image: { imageId: bobsImage, alt: "Stolen" } })).status).toBe(404);
    expect(
      (await create({ image: { imageId: "00000000-0000-4000-8000-000000000000", alt: "None" } }))
        .status,
    ).toBe(404);
  });

  it("creates a question without an image as before", async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body.question.image).toBeNull();
  });
});

describe("editing keeps the image across revisions", () => {
  it("keeps it through content edits, shuffles, and review changes, and removes it only on request", async () => {
    const id = await stage();
    const created = await create({ image: { imageId: id, alt: "A cat" } });
    const qid = created.body.question.id as string;
    const rev1 = created.body.question.revisionId as string;

    const edited = await patch(qid, { prompt: "What animal is this?" });
    expect(edited.body.question).toMatchObject({ revisionNumber: 2, image: { id, alt: "A cat" } });

    const shuffled = await call(shufflePost, "/x", alice, {
      method: "POST",
      params: { questionId: qid },
    });
    expect(shuffled.body.question).toMatchObject({
      revisionNumber: 3,
      image: { id, alt: "A cat" },
    });

    const removed = await patch(qid, { image: null });
    expect(removed.body.question).toMatchObject({ revisionNumber: 4, image: null });
    expect(await linkOf(removed.body.question.revisionId)).toBeUndefined();

    // Older revisions still show what they showed.
    expect(await linkOf(rev1)).toMatchObject({ imageId: id, altText: "A cat" });
    expect(await linkOf(edited.body.question.revisionId)).toMatchObject({ imageId: id });

    // A later edit does not bring it back.
    const after = await patch(qid, { prompt: "Still no image?" });
    expect(after.body.question.image).toBeNull();
  });

  it("replaces the image, or only its alt text, as a new revision", async () => {
    const first = await stage();
    const created = await create({ image: { imageId: first, alt: "First" } });
    const qid = created.body.question.id as string;
    const rev1 = created.body.question.revisionId as string;

    const second = await stage(alice, setId, JPEG_BYTES);
    const replaced = await patch(qid, { image: { imageId: second, alt: "Second" } });
    expect(replaced.body.question).toMatchObject({
      revisionNumber: 2,
      image: { id: second, alt: "Second" },
    });

    const altOnly = await patch(qid, { image: { imageId: second, alt: "Second, clearer" } });
    expect(altOnly.body.question).toMatchObject({
      revisionNumber: 3,
      image: { id: second, alt: "Second, clearer" },
    });

    expect(await linkOf(rev1)).toMatchObject({ imageId: first, altText: "First" });
    expect(await linkOf(replaced.body.question.revisionId)).toMatchObject({ altText: "Second" });
  });

  it("can add an image to a question that had none", async () => {
    const created = await create();
    const qid = created.body.question.id as string;
    const id = await stage();
    const attached = await patch(qid, { image: { imageId: id, alt: "Added later" } });
    expect(attached.body.question).toMatchObject({
      revisionNumber: 2,
      image: { id, alt: "Added later" },
    });
  });

  it("refuses to attach someone else's image on edit", async () => {
    const created = await create();
    const bobsImage = await stage(bob, bobSetId);
    const res = await patch(created.body.question.id, { image: { imageId: bobsImage, alt: "No" } });
    expect(res.status).toBe(404);
  });
});

describe("deleting a question deletes the images only it showed", () => {
  it("removes the row and the stored bytes", async () => {
    const id = await stage();
    const created = await create({ image: { imageId: id, alt: "Temporary" } });
    const [row] = await db.select().from(questionImages).where(eq(questionImages.id, id));
    const file = path.join(storageDir, row!.storageKey);
    await access(file);

    const del = await call(questionDelete, "/x", alice, {
      method: "DELETE",
      params: { questionId: created.body.question.id },
    });
    expect(del.status).toBe(204);
    expect((await fetchImage(alice, id)).status).toBe(404);
    await expect(access(file)).rejects.toBeTruthy();
  });

  it("keeps an image that another question still shows", async () => {
    const id = await stage();
    const a = await create({ image: { imageId: id, alt: "Shared" } });
    const b = await create({ image: { imageId: id, alt: "Shared too" } });
    await call(questionDelete, "/x", alice, {
      method: "DELETE",
      params: { questionId: a.body.question.id },
    });
    expect((await fetchImage(alice, id)).status).toBe(200);
    const rows = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, b.body.question.id));
    expect(rows).toHaveLength(1);
  });
});

describe("practising a question with an image", () => {
  it("shows the image and its alt text in play, pinned to the session, with no answer key", async () => {
    const course = await createCourse(db, alice.id, { title: "Play", subject: "S" });
    const playSet = (await createQuestionSet(db, alice.id, course.id, "Play set")).id;
    const id = await stage(alice, playSet);
    const created = await call(questionsPost, "/x", alice, {
      body: mcq({ image: { imageId: id, alt: "A cat on a sofa" } }),
      params: { setId: playSet },
    });
    expect(created.status).toBe(201);

    const { session } = await startOrResumeSession(db, alice.id, playSet);
    expect(session.current?.image).toEqual({
      id,
      url: `/api/images/${id}`,
      alt: "A cat on a sofa",
    });
    expect(JSON.stringify(session)).not.toMatch(/correctOptionIds|answerKey|isCorrect/);

    // Removing the image afterwards does not change a session that already started.
    await patch(created.body.question.id, { image: null });
    const again = await getSession(db, alice.id, session.id);
    expect(again.current?.image).toMatchObject({ id, alt: "A cat on a sofa" });
    // The student can load the picture; nobody else can.
    expect((await fetchImage(alice, id)).status).toBe(200);
    expect((await fetchImage(bob, id)).status).toBe(404);
  });

  it("has no image field value for questions without one", async () => {
    const course = await createCourse(db, alice.id, { title: "Plain", subject: "S" });
    const plainSet = (await createQuestionSet(db, alice.id, course.id, "Plain set")).id;
    await call(questionsPost, "/x", alice, { body: mcq(), params: { setId: plainSet } });
    const { session } = await startOrResumeSession(db, alice.id, plainSet);
    expect(session.current?.image).toBeNull();
  });
});
