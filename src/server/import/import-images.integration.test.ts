import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-import-images-"));
process.env.STORAGE_DIR = storageDir;
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { GET as imageGet } from "@/app/api/images/[imageId]/route";
import { POST as uploadPost } from "@/app/api/courses/[courseId]/imports/route";
import { PATCH as itemPatch } from "@/app/api/imports/[importId]/items/[itemId]/route";
import { POST as publishPost } from "@/app/api/imports/[importId]/publish/route";
import { call } from "@/test/api";
import { authRequest } from "@/test/auth-helpers";
import { GIF_BYTES, PNG_BYTES } from "@/test/images";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "@/server/content/courses";
import { listQuestions } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { questionImages } from "@/server/db/schema";
import { clearDetectors } from "./detectors";
import { clearExtractors } from "@/server/extract/registry";

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let courseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
});
beforeEach(async () => {
  clearExtractors();
  clearDetectors();
  courseId = (await createCourse(db, alice.id, { title: `C ${Math.random()}`, subject: "CS" })).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
  await rm(storageDir, { recursive: true, force: true });
});

type Item = {
  id: string;
  decision: string;
  warnings: { code: string }[];
  payload: { image?: { imageId: string; alt: string } | null };
};
type Draft = { id: string; warnings: { code: string }[]; items: Item[] };

async function fixture(name: string) {
  return readFile(path.join(process.cwd(), "fixtures/docx", name));
}

async function upload(bytes: Buffer, name = "q.docx") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name));
  const response = await uploadPost(
    new Request("http://localhost:3000/x", {
      method: "POST",
      headers: { cookie: alice.cookie, origin: "http://localhost:3000" },
      body: form,
    }),
    { params: Promise.resolve({ courseId }) },
  );
  expect(response.status).toBe(201);
  return (await response.json()).import as Draft;
}

const patch = (user: TestUser, draft: Draft, item: Item, body: unknown) =>
  call(itemPatch, "/x", user, {
    method: "PATCH",
    body,
    params: { importId: draft.id, itemId: item.id },
  });

async function fetchImage(user: TestUser, id: string) {
  return imageGet(authRequest(`/api/images/${id}`, { cookie: user.cookie }), {
    params: Promise.resolve({ imageId: id }),
  });
}

/** The same document with its picture replaced by other bytes (still named like a PNG). */
async function withMedia(name: string, replace: (bytes: Uint8Array) => Uint8Array) {
  const files: Record<string, Uint8Array> = unzipSync(new Uint8Array(await fixture(name)));
  const entry = Object.keys(files).find((n) => n.startsWith("word/media/") && !n.endsWith("/"))!;
  files[entry] = replace(files[entry]!);
  return Buffer.from(zipSync(files));
}

describe("images in imported DOCX questions", () => {
  it("stores the picture privately with the author's description", async () => {
    const draft = await upload(await fixture("image-with-alt.docx"));
    const item = draft.items[0]!;
    expect(item.payload.image).toMatchObject({ alt: "A stack of three plates" });
    expect(item.warnings.map((w) => w.code)).toEqual([]);
    expect(draft.warnings.map((w) => w.code)).not.toContain("image_dependency");

    const id = item.payload.image!.imageId;
    const mine = await fetchImage(alice, id);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await mine.arrayBuffer()).length).toBeGreaterThan(0);
    expect((await fetchImage(bob, id)).status).toBe(404);
  });

  it("needs a description before the question can be accepted, then publishes the image", async () => {
    const draft = await upload(await fixture("image-in-question.docx"));
    const item = draft.items[0]!;
    expect(item.payload.image).toMatchObject({ alt: "" });
    expect(item.warnings.map((w) => w.code)).toEqual(["image_alt_missing"]);

    const refused = await patch(alice, draft, item, { decision: "accepted" });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("image_alt_required");

    const imageId = item.payload.image!.imageId;
    const described = await patch(alice, draft, item, {
      edit: { image: { imageId, alt: "A diagram of a stack" } },
      decision: "accepted",
    });
    expect(described.status).toBe(200);
    const after = described.body.import.items[0] as Item;
    expect(after.decision).toBe("edited");
    expect(after.warnings.map((w) => w.code)).not.toContain("image_alt_missing");

    const published = await call(publishPost, "/x", alice, {
      body: { title: "With image" },
      params: { importId: draft.id },
    });
    expect(published.status).toBe(201);

    const [question] = await listQuestions(db, alice.id, published.body.questionSetId);
    expect(question!.image).toEqual({
      id: imageId,
      url: `/api/images/${imageId}`,
      alt: "A diagram of a stack",
    });
  });

  it("refuses to describe a different image, or someone else's draft", async () => {
    const draft = await upload(await fixture("image-in-question.docx"));
    const item = draft.items[0]!;
    const other = await patch(alice, draft, item, {
      edit: { image: { imageId: "00000000-0000-4000-8000-000000000000", alt: "Nope" } },
    });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe("image_mismatch");
    const stranger = await patch(bob, draft, item, {
      edit: { image: { imageId: item.payload.image!.imageId, alt: "Mine now" } },
    });
    expect(stranger.status).toBe(404);
  });

  it("lets the owner drop the image and accept the question without it", async () => {
    const draft = await upload(await fixture("image-in-question.docx"));
    const item = draft.items[0]!;
    const dropped = await patch(alice, draft, item, {
      edit: { image: null },
      decision: "accepted",
    });
    expect(dropped.status).toBe(200);
    const after = dropped.body.import.items[0] as Item;
    expect(after.payload.image ?? null).toBeNull();
    const published = await call(publishPost, "/x", alice, {
      body: { title: "No image" },
      params: { importId: draft.id },
    });
    const [question] = await listQuestions(db, alice.id, published.body.questionSetId);
    expect(question!.image).toBeNull();
  });

  it("keeps the 'image not imported' warning when the picture cannot be kept", async () => {
    // The file is named like a PNG but its bytes are a GIF, which is not supported.
    const gif = await withMedia("image-with-alt.docx", () => GIF_BYTES);
    const before = await db
      .select()
      .from(questionImages)
      .where(eq(questionImages.ownerId, alice.id));
    const draft = await upload(gif);
    expect(draft.items[0]!.payload.image ?? null).toBeNull();
    expect(draft.items[0]!.warnings.map((w) => w.code)).toContain("image_dependency");
    expect(draft.warnings.map((w) => w.code)).toContain("image_dependency");
    const after = await db
      .select()
      .from(questionImages)
      .where(eq(questionImages.ownerId, alice.id));
    expect(after).toHaveLength(before.length);
  });

  it("keeps the warning for a picture over the size limit, without failing the import", async () => {
    const big = await withMedia("image-with-alt.docx", () => {
      const bytes = new Uint8Array(3 * 1024 * 1024);
      bytes.set(PNG_BYTES);
      return bytes;
    });
    const draft = await upload(big);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]!.payload.image ?? null).toBeNull();
    expect(draft.warnings.map((w) => w.code)).toContain("image_dependency");
  });

  it("does not attach an image to a document without one", async () => {
    const draft = await upload(await fixture("numbered-list.docx"));
    expect(draft.items.every((i) => !i.payload.image)).toBe(true);
  });
});
