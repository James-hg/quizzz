import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { limitsFromEnv } from "@/server/extract/limits";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";
import { createImport } from "@/server/import/drafts";
import { readUpload } from "@/server/import/upload";
import { getStorage } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string }> };

export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const courseId = parseId((await params).courseId, "Course");
  const limits = limitsFromEnv(getEnv());
  const upload = await readUpload(request, limits.maxUploadBytes);
  const draft = await createImport(getDb(), getStorage(), user.id, courseId, upload, limits);
  return NextResponse.json({ import: draft }, { status: 201 });
});
