import { describe, expect, it } from "vitest";
import { Timeout } from "./errors";
import { withTimeout } from "./timeout";

describe("withTimeout", () => {
  it("returns the result when the task finishes in time", async () => {
    await expect(withTimeout(async () => 42, 100)).resolves.toBe(42);
  });

  it("aborts a slow task that honours the signal", async () => {
    let aborted = false;
    const slow = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve("late"), 500);
      });
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(Timeout);
    expect(aborted).toBe(true);
  });

  it("still times out a task that ignores the signal", async () => {
    await expect(
      withTimeout(() => new Promise<string>((r) => setTimeout(() => r("late"), 300)), 20),
    ).rejects.toBeInstanceOf(Timeout);
  });

  it("aborts when the parent signal aborts", async () => {
    const parent = new AbortController();
    const seen = withTimeout(
      (signal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("parent"))),
        ),
      1000,
      parent.signal,
    );
    parent.abort();
    await expect(seen).rejects.toThrow("parent");
  });
});
