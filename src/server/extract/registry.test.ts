import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { Corrupt, Timeout, UnsupportedFormat } from "./errors";
import { DEFAULT_LIMITS } from "./limits";
import { clearExtractors, findExtractor, registerExtractor, runExtraction } from "./registry";
import type { Extractor, ExtractResult } from "./types";

const empty: ExtractResult = { blocks: [], assets: [], warnings: [], meta: { format: "fake" } };
const zipBytes = Buffer.from(zipSync({ "a.xml": strToU8("<a/>") }));
const file = { filename: "a.docx", mimeType: "" };

function fake(overrides: Partial<Extractor> = {}): Extractor {
  return {
    name: "fake",
    canHandle: (f) => f.filename.endsWith(".docx"),
    extract: async () => empty,
    ...overrides,
  };
}

afterEach(clearExtractors);

describe("extractor registry", () => {
  it("routes a validated file to the matching extractor", async () => {
    registerExtractor(fake());
    expect(findExtractor({ ...file })?.name).toBe("fake");
    await expect(runExtraction(zipBytes, file, DEFAULT_LIMITS)).resolves.toEqual(empty);
  });

  it("rejects files no extractor handles", async () => {
    await expect(runExtraction(zipBytes, file, DEFAULT_LIMITS)).rejects.toBeInstanceOf(
      UnsupportedFormat,
    );
  });

  it("refuses duplicate registrations", () => {
    registerExtractor(fake());
    expect(() => registerExtractor(fake())).toThrow(/already registered/);
  });

  it("aborts a slow extractor with Timeout", async () => {
    let aborted = false;
    registerExtractor(
      fake({
        extract: (_b, _l, signal) =>
          new Promise<ExtractResult>((resolve) => {
            signal.addEventListener("abort", () => (aborted = true));
            setTimeout(() => resolve(empty), 500);
          }),
      }),
    );
    await expect(
      runExtraction(zipBytes, file, { ...DEFAULT_LIMITS, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(Timeout);
    expect(aborted).toBe(true);
  });

  it("turns unexpected extractor failures into Corrupt", async () => {
    registerExtractor(
      fake({
        extract: async () => {
          throw new TypeError("parser blew up");
        },
      }),
    );
    await expect(runExtraction(zipBytes, file, DEFAULT_LIMITS)).rejects.toBeInstanceOf(Corrupt);
  });

  it("rejects extractor output that breaks the schema", async () => {
    registerExtractor(fake({ extract: async () => ({ blocks: [{}] }) as never }));
    await expect(runExtraction(zipBytes, file, DEFAULT_LIMITS)).rejects.toBeInstanceOf(Corrupt);
  });
});
