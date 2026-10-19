import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const emptyDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-no-samples-"));
process.env.SAMPLES_DIR = emptyDir;
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { GET as listGet } from "@/app/api/samples/route";
import { POST as loadPost } from "@/app/api/samples/[language]/load/route";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { getDb } from "@/server/db";
import { readSamples } from "./directory";

const db = getDb();
let user: TestUser;
beforeAll(async () => {
  user = await signUpUser(db);
});
afterAll(async () => {
  await deleteUsers(db, [user.id]);
  await rm(emptyDir, { recursive: true, force: true });
});

describe("zero sample courses", () => {
  it("lists nothing and shows no fake content", async () => {
    const response = await listGet(authRequest("/x", { cookie: user.cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ samples: [] });
  });

  it("returns 404 when asked to load a sample that does not exist", async () => {
    const response = await loadPost(authRequest("/x", { method: "POST", cookie: user.cookie }), {
      params: Promise.resolve({ language: "python" }),
    });
    expect(response.status).toBe(404);
  });

  it("treats a missing directory as no samples rather than an error", async () => {
    expect(await readSamples(path.join(emptyDir, "does-not-exist"))).toEqual({
      samples: [],
      problems: [],
    });
  });
});
