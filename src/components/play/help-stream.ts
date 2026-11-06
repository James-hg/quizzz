import type { HelpResult } from "@/lib/client/types";

/** The help stream ended without a valid final record, so nothing in it counts as saved help. */
export class HelpStreamError extends Error {
  constructor(message = "The help reply was cut off. Try again.") {
    super(message);
    this.name = "HelpStreamError";
  }
}

type RawEvent = { name: string; data: string };

/** Splits server-sent events out of a growing buffer; returns the events and the unread rest. */
export function takeEvents(buffer: string): { events: RawEvent[]; rest: string } {
  const events: RawEvent[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end === -1) break;
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let name = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) events.push({ name, data: data.join("\n") });
  }
  return { events, rest };
}

/**
 * Reads the help stream: text arrives in chunks, then one `done` event carries the recorded help.
 * Only that final record is returned. A stream that ends without it, or carries a malformed
 * event, is an error: the partial text was never confirmed as saved and must not be shown as help.
 */
export async function readHelpStream(
  response: Response,
  onText: (chunk: string) => void,
): Promise<HelpResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new HelpStreamError();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: HelpResult | null = null;

  const handle = (events: RawEvent[]) => {
    for (const event of events) {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        throw new HelpStreamError();
      }
      if (event.name === "text") {
        const text = (payload as { text?: unknown }).text;
        if (typeof text !== "string") throw new HelpStreamError();
        onText(text);
      } else if (event.name === "done") {
        const help = (payload as { help?: unknown }).help as HelpResult | undefined;
        if (!help || typeof help.text !== "string" || typeof help.id !== "string") {
          throw new HelpStreamError();
        }
        done = help;
      }
    }
  };

  try {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !finished });
        const taken = takeEvents(buffer);
        buffer = taken.rest;
        handle(taken.events);
      }
      if (finished) break;
    }
    buffer += decoder.decode();
    handle(takeEvents(`${buffer}\n\n`).events);
  } catch (error) {
    if (error instanceof HelpStreamError) throw error;
    // An abort is the caller's decision, not a broken stream.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new HelpStreamError();
  }
  if (!done) throw new HelpStreamError();
  return done;
}
