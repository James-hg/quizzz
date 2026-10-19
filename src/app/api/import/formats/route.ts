import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getEnv } from "@/server/env";
import { supportedFormats } from "@/server/extract/registry";
import { handleRoute } from "@/server/http/errors";
import { ensureImportersRegistered } from "@/server/import/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleRoute(async (request: Request) => {
  await requireUser(request);
  ensureImportersRegistered();
  return NextResponse.json({
    formats: supportedFormats(),
    maxUploadBytes: getEnv().MAX_UPLOAD_BYTES,
  });
});
