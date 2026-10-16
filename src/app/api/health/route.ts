import { NextResponse } from "next/server";
import { getDb } from "@/server/db";
import { checkDb } from "@/server/db/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let db = false;
  try {
    db = await checkDb(getDb());
  } catch {
    // Missing/invalid env or client construction failure: report db: false, never crash.
  }
  return NextResponse.json({ ok: true, db });
}
