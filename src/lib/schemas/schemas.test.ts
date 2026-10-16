import { describe, expect, it } from "vitest";
import { anchorSchema, answerKeySchema, optionsSchema, responseSchema } from "./index";

describe("jsonb schemas", () => {
  it("rejects duplicate option ids", () => {
    expect(
      optionsSchema.safeParse([
        { id: "a", text: "x" },
        { id: "a", text: "y" },
      ]).success,
    ).toBe(false);
  });

  it("parses answer keys by kind and defaults caseSensitive", () => {
    const key = answerKeySchema.parse({ kind: "text", accepted: ["42"] });
    expect(key).toEqual({ kind: "text", accepted: ["42"], caseSensitive: false });
    expect(answerKeySchema.safeParse({ kind: "options", correctOptionIds: [] }).success).toBe(
      false,
    );
  });

  it("rejects an empty anchor", () => {
    expect(anchorSchema.safeParse({}).success).toBe(false);
    expect(anchorSchema.safeParse({ page: 3 }).success).toBe(true);
  });

  it("rejects an unknown response kind", () => {
    expect(responseSchema.safeParse({ kind: "voice" }).success).toBe(false);
  });
});
