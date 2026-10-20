import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb, type Database } from "@/server/db";
import { account, rateLimit, session, user, verification } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth-rules";

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

type AuthOptions = {
  baseURL: string;
  secret: string;
  secureCookies?: boolean;
  /** Per-minute cap on sign-in / sign-up per client IP. */
  authRateLimitMax?: number;
};

export function createAuth(db: Database, options: AuthOptions) {
  const secure = options.secureCookies ?? false;
  const authLimit = { window: 60, max: options.authRateLimitMax ?? 10 };
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification, rateLimit },
    }),
    emailAndPassword: {
      enabled: true,
      // Flip to true when email delivery exists. Local installs need no mail server.
      requireEmailVerification: false,
      // Length only: passwords are never trimmed or otherwise transformed.
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        displayName: { type: "string", required: false },
        // Written only by PATCH /api/me, which validates it as an IANA zone.
        timezone: { type: "string", required: false, input: false, defaultValue: "UTC" },
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": authLimit,
        "/sign-up/email": authLimit,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __quizzzAuth?: Auth };

export function getAuth(): Auth {
  if (!globalForAuth.__quizzzAuth) {
    const env = getEnv();
    globalForAuth.__quizzzAuth = createAuth(getDb(), {
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      secureCookies: process.env.NODE_ENV === "production",
      authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
    });
  }
  return globalForAuth.__quizzzAuth;
}
