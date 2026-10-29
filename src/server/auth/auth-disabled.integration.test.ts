import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.AUTH_DISABLED = "true";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { GET as meGet, PATCH as mePatch } from "@/app/api/me/route";
import { GET as coursesGet, POST as coursesPost } from "@/app/api/courses/route";
import { GET as courseGet } from "@/app/api/courses/[courseId]/route";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "@/server/content/courses";
import { getDb } from "@/server/db";
import { courses, user } from "@/server/db/schema";
import { getLocalUser } from "./local-user";
import { requireUser } from "./session";

const db = getDb();
let other: TestUser;

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  other = await signUpUser(db);
});

afterAll(async () => {
  const local = await getLocalUser();
  await db.delete(courses).where(eq(courses.ownerId, local.id));
  await deleteUsers(db, [other.id, local.id]);
});

describe("with login disabled", () => {
  it("treats a request with no cookie as the built-in local user", async () => {
    const current = await requireUser(authRequest("/api/me"));
    expect(current).toMatchObject({
      email: "local@quizzz.local",
      name: "Local user",
      timezone: "UTC",
    });
    expect(current.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("always returns the same local user, creating it only once", async () => {
    const a = await requireUser(authRequest("/api/me"));
    const b = await requireUser(authRequest("/api/me"));
    expect(b.id).toBe(a.id);
    expect((await getLocalUser()).id).toBe(a.id);
    const rows = await db.select().from(user).where(eq(user.email, "local@quizzz.local"));
    expect(rows).toHaveLength(1);
  });

  it("lets the API be used without signing in, and data belongs to the local user", async () => {
    const me = await meGet(authRequest("/api/me"));
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("local@quizzz.local");

    const created = await coursesPost(
      authRequest("/api/courses", { body: { title: "No login", subject: "Test" } }),
    );
    expect(created.status).toBe(201);
    const { course } = await created.json();
    const [row] = await db.select().from(courses).where(eq(courses.id, course.id));
    expect(row?.ownerId).toBe((await getLocalUser()).id);

    const list = await (await coursesGet(authRequest("/api/courses"))).json();
    expect(list.courses.map((c: { id: string }) => c.id)).toContain(course.id);

    const patched = await mePatch(
      authRequest("/api/me", { method: "PATCH", body: { timezone: "America/Vancouver" } }),
    );
    expect(patched.status).toBe(200);
  });

  it("shows profile changes on the next request, without a restart", async () => {
    const patched = await mePatch(
      authRequest("/api/me", {
        method: "PATCH",
        body: { displayName: "Me at home", timezone: "Asia/Tokyo" },
      }),
    );
    expect(patched.status).toBe(200);

    const current = await requireUser(authRequest("/api/me"));
    expect(current).toMatchObject({ displayName: "Me at home", timezone: "Asia/Tokyo" });
    const me = await (await meGet(authRequest("/api/me"))).json();
    expect(me.user).toMatchObject({ displayName: "Me at home", timezone: "Asia/Tokyo" });
  });

  it("refuses to change the local user's email, but accepts the unchanged one", async () => {
    const before = await getLocalUser();
    const changed = await mePatch(
      authRequest("/api/me", { method: "PATCH", body: { email: "someone@example.test" } }),
    );
    expect(changed.status).toBe(400);
    expect((await changed.json()).error.code).toBe("local_user_email_fixed");
    const [row] = await db.select().from(user).where(eq(user.id, before.id));
    expect(row?.email).toBe("local@quizzz.local");

    const same = await mePatch(
      authRequest("/api/me", { method: "PATCH", body: { email: "LOCAL@quizzz.local" } }),
    );
    expect(same.status).toBe(200);
    expect((await getLocalUser()).id).toBe(before.id);
  });

  it("does not let the local user see another real user's data", async () => {
    const theirs = await createCourse(db, other.id, { title: "Private", subject: "x" });
    const response = await courseGet(authRequest(`/api/courses/${theirs.id}`), {
      params: Promise.resolve({ courseId: theirs.id }),
    });
    expect(response.status).toBe(404);
  });

  it("ignores a session cookie that belongs to someone else", async () => {
    const current = await requireUser(authRequest("/api/me", { cookie: other.cookie }));
    expect(current.email).toBe("local@quizzz.local");
    expect(current.id).not.toBe(other.id);
  });
});
