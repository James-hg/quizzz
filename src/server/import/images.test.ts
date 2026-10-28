import { describe, expect, it } from "vitest";
import { clampAlt } from "./images";

describe("clampAlt", () => {
  it("keeps a description that fits, trimmed, and turns a missing one into an empty string", () => {
    expect(clampAlt("  A stack of plates ")).toBe("A stack of plates");
    expect(clampAlt(undefined)).toBe("");
    expect(clampAlt("   ")).toBe("");
  });

  it("cuts a longer description to the limit instead of failing", () => {
    const long = "word ".repeat(200);
    const clamped = clampAlt(long);
    expect(clamped.length).toBeLessThanOrEqual(300);
    expect(clamped.startsWith("word word")).toBe(true);
    expect(clampAlt("x".repeat(300))).toHaveLength(300);
    expect(clampAlt("x".repeat(301))).toHaveLength(300);
  });

  it("never leaves half of an emoji at the cut", () => {
    const text = "a".repeat(299) + "😀😀";
    const clamped = clampAlt(text);
    expect(clamped).toBe("a".repeat(299));
    expect(clamped).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});
