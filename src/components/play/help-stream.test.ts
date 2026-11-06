import { describe, expect, it } from "vitest";
import { HelpStreamError, readHelpStream, takeEvents } from "./help-stream";

const help = {
  id: "h1",
  questionId: "q1",
  pass: 1,
  action: "small_hint",
  level: "conceptual_hint",
  text: "Think about counting.",
  citations: [],
  sourceSupported: false,
  origin: "approved",
  servedAs: "requested",
};

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("takeEvents", () => {
  it("returns whole events and keeps the unfinished rest", () => {
    const { events, rest } = takeEvents(`${event("text", { text: "a" })}event: te`);
    expect(events).toEqual([{ name: "text", data: '{"text":"a"}' }]);
    expect(rest).toBe("event: te");
  });

  it("accepts CRLF line endings", () => {
    expect(takeEvents('event: done\r\ndata: {"a":1}\r\n\r\n').events).toEqual([
      { name: "done", data: '{"a":1}' },
    ]);
  });
});

describe("readHelpStream", () => {
  it("passes text chunks on and returns only the final record", async () => {
    const seen: string[] = [];
    const response = streamOf([
      event("text", { text: "Think " }),
      event("text", { text: "about counting." }),
      event("done", { help }),
    ]);
    expect(await readHelpStream(response, (t) => seen.push(t))).toEqual(help);
    expect(seen.join("")).toBe("Think about counting.");
  });

  it("copes with events split across network chunks", async () => {
    const whole = event("text", { text: "Hi" }) + event("done", { help });
    const response = streamOf([whole.slice(0, 7), whole.slice(7, 40), whole.slice(40)]);
    expect((await readHelpStream(response, () => {})).id).toBe("h1");
  });

  it.each([
    ["ends without a final record", [event("text", { text: "partial" })]],
    ["has a malformed event", ["event: text\ndata: {nope\n\n"]],
    ["has a final record without a text", [event("done", { help: { id: "h1" } })]],
    ["has a text event without text", [event("text", { nope: 1 })]],
    ["is empty", []],
  ])("fails when the stream %s, and never returns the partial text as help", async (_l, chunks) => {
    await expect(readHelpStream(streamOf(chunks), () => {})).rejects.toBeInstanceOf(
      HelpStreamError,
    );
  });

  it("fails when there is no body", async () => {
    await expect(readHelpStream(new Response(null), () => {})).rejects.toBeInstanceOf(
      HelpStreamError,
    );
  });
});
