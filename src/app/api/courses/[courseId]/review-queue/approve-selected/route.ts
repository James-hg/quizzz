import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { approveSelected, approveSelectedSchema } from "@/server/content-checks/review";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string }> };

/** Approves up to 50 questions at once, or none of them if any cannot be approved. */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const courseId = parseId((await params).courseId, "Course");
  const { revisionIds } = await readJson(request, approveSelectedSchema);
  const questions = await approveSelected(getDb(), user.id, courseId, revisionIds);
  return NextResponse.json({ questions });
});
