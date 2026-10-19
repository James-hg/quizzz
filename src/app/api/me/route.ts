import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { updateProfileSchema } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { user } from "@/server/db/schema";
import { badRequest, conflict, handleRoute } from "@/server/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publicFields = {
  id: user.id,
  email: user.email,
  name: user.name,
  displayName: user.displayName,
  timezone: user.timezone,
};

export const GET = handleRoute(async (request: Request) => {
  const current = await requireUser(request);
  return NextResponse.json({ user: current });
});

export const PATCH = handleRoute(async (request: Request) => {
  const current = await requireUser(request);
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw badRequest("Request body must be JSON");
  }
  const input = updateProfileSchema.parse(json);
  const db = getDb();

  if (input.email) {
    const email = input.email.toLowerCase();
    const [taken] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (taken && taken.id !== current.id) throw conflict("Email already in use", "email_taken");
    input.email = email;
  }

  try {
    const [updated] = await db
      .update(user)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(user.id, current.id))
      .returning(publicFields);
    return NextResponse.json({ user: updated });
  } catch (error) {
    // Lost a race against another request taking the same email.
    if ((error as { cause?: { code?: string } }).cause?.code === "23505") {
      throw conflict("Email already in use", "email_taken");
    }
    throw error;
  }
});
