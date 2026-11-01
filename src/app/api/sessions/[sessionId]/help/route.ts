import { NextResponse } from "next/server";
import { helpRequestSchema, type HelpResponse } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";
import { getHelp } from "@/server/tutor/help";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" };
const CHUNK_CHARS = 80;

/**
 * Event stream of an already validated help response: the text in small chunks, then the full
 * record. Nothing is sent before the whole answer has been checked, so the student never sees
 * text that was later rejected. (This does not make the first words arrive sooner.)
 */
function streamOf({ help }: HelpResponse): Response {
  const encoder = new TextEncoder();
  const event = (name: string, data: unknown) =>
    encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < help.text.length; i += CHUNK_CHARS) {
        controller.enqueue(event("text", { text: help.text.slice(i, i + CHUNK_CHARS) }));
      }
      controller.enqueue(event("done", { help }));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { ...NO_STORE, "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

/**
 * Help for the question the student is on now. The turn and the strength of help are decided on
 * the server; the response says whether it is reviewed or AI-proposed and what it cites.
 */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  await requireUser(request);
  const id = parseId((await params).sessionId, "Session");
  const input = await readJson(request, helpRequestSchema);
  const result = await getHelp(getDb(), request, id, input);
  if (request.headers.get("accept")?.includes("text/event-stream")) return streamOf(result);
  return NextResponse.json(result, { headers: NO_STORE });
});
