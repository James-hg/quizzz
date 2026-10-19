import { describe, expect, it } from "vitest";
import {
  anchorSchema,
  answerKeySchema,
  draftQuestionPayloadSchema,
  optionsSchema,
  publishImportSchema,
  responseSchema,
} from "./index";

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

  it("accepts the unresolved answer key", () => {
    expect(answerKeySchema.parse({ kind: "unresolved" })).toEqual({ kind: "unresolved" });
  });

  it("allows unresolved draft questions but rejects bad answers", () => {
    const base = {
      kind: "question",
      type: "mcq_single",
      prompt: "Q",
      options: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
    };
    expect(draftQuestionPayloadSchema.safeParse({ ...base, correctOptionIds: [] }).success).toBe(
      true,
    );
    expect(draftQuestionPayloadSchema.safeParse({ ...base, correctOptionIds: ["z"] }).success).toBe(
      false,
    );
    expect(
      draftQuestionPayloadSchema.safeParse({ ...base, correctOptionIds: ["a", "b"] }).success,
    ).toBe(false);
  });

  it("publish needs exactly one of title or questionSetId", () => {
    expect(publishImportSchema.safeParse({}).success).toBe(false);
    expect(publishImportSchema.safeParse({ title: "x" }).success).toBe(true);
  });
});
