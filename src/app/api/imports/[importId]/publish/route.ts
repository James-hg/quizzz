import { NextResponse } from "next/server";
import { publishImportSchema } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";
import { publishImport } from "@/server/import/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ importId: string }> };

export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).importId, "Import");
  const input = await readJson(request, publishImportSchema);
  const result = await publishImport(getDb(), user.id, id, input);
  // A retry returns the original question set with 200 instead of creating another.
  return NextResponse.json(result, { status: result.alreadyPublished ? 200 : 201 });
});
