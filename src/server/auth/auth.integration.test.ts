import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as authGet, POST as authPost } from "@/app/api/auth/[...all]/route";
import { GET as meGet, PATCH as mePatch } from "@/app/api/me/route";
import { authRequest, cookieFrom } from "@/test/auth-helpers";
import { createDb, getDb } from "@/server/db";
import { courses, session, user } from "@/server/db/schema";
import { createAuth } from "./index";
import { assertOwnsCourse } from "./ownership";
import { requireUser } from "./session";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const emails: string[] = [];
const db = getDb();

function newEmail() {
  const email = `${randomUUID()}@example.test`;
  emails.push(email);
  return email;
}

async function signUp(email = newEmail(), password = "correct horse", name = "Tester") {
  const response = await authPost(
    authRequest("/api/auth/sign-up/email", { body: { email, password, name } }),
  );
  return { email, password, response, cookie: cookieFrom(response) };
}

afterAll(async () => {
  if (emails.length === 0) return;
  const users = await db.select({ id: user.id }).from(user).where(inArray(user.email, emails));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(courses).where(inArray(courses.ownerId, ids));
    await db.delete(user).where(inArray(user.id, ids));
  }
});

describe("sign up, sign in, sign out", () => {
  it("signs up with an HttpOnly session cookie and returns no token to read", async () => {
    const { response, cookie } = await signUp();
    expect(response.status).toBe(200);
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toBe("");
  });

  it("returns the session over HTTP and ends it on sign out", async () => {
    const { cookie, email } = await signUp();
    const got = await authGet(authRequest("/api/auth/get-session", { cookie }));
    expect((await got.json()).user.email).toBe(email);

    const out = await authPost(authRequest("/api/auth/sign-out", { body: {}, cookie }));
    expect(out.status).toBe(200);
    const after = await authGet(authRequest("/api/auth/get-session", { cookie }));
    expect(await after.json()).toBeNull();
  });

  it("signs in again with the same email and password", async () => {
    const { email, password } = await signUp();
    const response = await authPost(
      authRequest("/api/auth/sign-in/email", { body: { email, password } }),
    );
    expect(response.status).toBe(200);
    expect(cookieFrom(response)).not.toBe("");
  });

  it("rejects a wrong password", async () => {
    const { email } = await signUp();
    const response = await authPost(
      authRequest("/api/auth/sign-in/email", { body: { email, password: "nope nope nope" } }),
    );
    expect(response.status).toBe(401);
  });

  it("keeps leading and trailing spaces in passwords on sign up and sign in", async () => {
    const { email, password } = await signUp(newEmail(), "  spaced secret  ");
    const ok = await authPost(
      authRequest("/api/auth/sign-in/email", { body: { email, password } }),
    );
    expect(ok.status).toBe(200);
    const trimmed = await authPost(
      authRequest("/api/auth/sign-in/email", { body: { email, password: password.trim() } }),
    );
    expect(trimmed.status).toBe(401);
  });

  it("changes the password only with the current password", async () => {
    const { email, password, cookie } = await signUp();
    const wrong = await authPost(
      authRequest("/api/auth/change-password", {
        body: { currentPassword: "wrong wrong", newPassword: "brand new pass" },
        cookie,
      }),
    );
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const ok = await authPost(
      authRequest("/api/auth/change-password", {
        body: { currentPassword: password, newPassword: "brand new pass" },
        cookie,
      }),
    );
    expect(ok.status).toBe(200);
    const signIn = await authPost(
      authRequest("/api/auth/sign-in/email", { body: { email, password: "brand new pass" } }),
    );
    expect(signIn.status).toBe(200);
  });

  it("stores no plaintext password", async () => {
    const { email, password } = await signUp();
    const rows = await db.execute<{ password: string }>(
      sql`select a.password from account a join "user" u on u.id = a.user_id where u.email = ${email}`,
    );
    expect(rows[0]?.password).toBeTruthy();
    expect(rows[0]?.password).not.toContain(password);
  });
});

describe("requireUser", () => {
  it("rejects a request without a session with 401", async () => {
    await expect(requireUser(authRequest("/api/me"))).rejects.toMatchObject({ status: 401 });
    const response = await meGet(authRequest("/api/me"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });

  it("rejects an expired session with 401", async () => {
    const { cookie, email } = await signUp();
    const [u] = await db.select().from(user).where(eq(user.email, email));
    await db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(session.userId, u!.id));
    const response = await meGet(authRequest("/api/me", { cookie }));
    expect(response.status).toBe(401);
  });

  it("accepts a valid session", async () => {
    const { cookie, email } = await signUp();
    const current = await requireUser(authRequest("/api/me", { cookie }));
    expect(current.email).toBe(email);
    expect(current.timezone).toBe("UTC");
  });
});

describe("PATCH /api/me", () => {
  it("updates display name and timezone", async () => {
    const { cookie } = await signUp();
    const response = await mePatch(
      authRequest("/api/me", {
        method: "PATCH",
        body: { displayName: "Ada", timezone: "America/Vancouver" },
        cookie,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.displayName).toBe("Ada");
    expect(body.user.timezone).toBe("America/Vancouver");
  });

  it("rejects an invalid timezone with 400", async () => {
    const { cookie } = await signUp();
    const response = await mePatch(
      authRequest("/api/me", { method: "PATCH", body: { timezone: "Mars/Base" }, cookie }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
  });

  it("enforces email uniqueness with 409 and allows a free email", async () => {
    const first = await signUp();
    const second = await signUp();
    const clash = await mePatch(
      authRequest("/api/me", {
        method: "PATCH",
        body: { email: first.email },
        cookie: second.cookie,
      }),
    );
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe("email_taken");

    const free = newEmail();
    const ok = await mePatch(
      authRequest("/api/me", { method: "PATCH", body: { email: free }, cookie: second.cookie }),
    );
    expect(ok.status).toBe(200);
  });

  it("requires a session", async () => {
    const response = await mePatch(
      authRequest("/api/me", { method: "PATCH", body: { displayName: "x" } }),
    );
    expect(response.status).toBe(401);
  });
});

describe("ownership", () => {
  it("returns 404 for another user's course and the owner's own succeeds", async () => {
    const a = await signUp();
    const b = await signUp();
    const [ua] = await db.select().from(user).where(eq(user.email, a.email));
    const [ub] = await db.select().from(user).where(eq(user.email, b.email));
    const [course] = await db
      .insert(courses)
      .values({ ownerId: ua!.id, title: "Mine", subject: "CS" })
      .returning();

    await expect(assertOwnsCourse(db, ua!.id, course!.id)).resolves.toMatchObject({
      id: course!.id,
    });
    await expect(assertOwnsCourse(db, ub!.id, course!.id)).rejects.toMatchObject({ status: 404 });
    await expect(assertOwnsCourse(db, ub!.id, randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe("rate limiting", () => {
  it("throttles repeated sign-in attempts from one client", async () => {
    const handle = createDb(process.env.TEST_DATABASE_URL!, 2);
    const limited = createAuth(handle.db, {
      baseURL: "http://localhost:3000",
      secret: "x".repeat(32),
      authRateLimitMax: 2,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const request = authRequest("/api/auth/sign-in/email", {
        body: { email: `nobody-${i}@example.test`, password: "whatever pass" },
      });
      request.headers.set("x-forwarded-for", `203.0.113.${randomUUID().length}`);
      const response = await limited.handler(request);
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    await handle.client.end();
  });
});
