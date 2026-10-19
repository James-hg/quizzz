import { NextResponse } from "next/server";
import { patchImportItemSchema } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";
import { patchImportItem } from "@/server/import/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ importId: string; itemId: string }> };

export const PATCH = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const { importId, itemId } = await params;
  const input = await readJson(request, patchImportItemSchema);
  const draft = await patchImportItem(
    getDb(),
    user.id,
    parseId(importId, "Import"),
    parseId(itemId, "Import item"),
    input,
  );
  return NextResponse.json({ import: draft });
});
