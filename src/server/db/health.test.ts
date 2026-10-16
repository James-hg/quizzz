import { describe, expect, it } from "vitest";
import type { Database } from "./index";
import { checkDb } from "./health";

describe("checkDb", () => {
  it("returns false instead of throwing when the query fails", async () => {
    const broken = {
      execute: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Database;
    expect(await checkDb(broken)).toBe(false);
  });
});
