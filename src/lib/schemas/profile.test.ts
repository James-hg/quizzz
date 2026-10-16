import { describe, expect, it } from "vitest";
import { isIanaTimezone, updateProfileSchema } from "./profile";

describe("profile schemas", () => {
  it("accepts IANA timezones and UTC", () => {
    expect(isIanaTimezone("America/Vancouver")).toBe(true);
    expect(isIanaTimezone("UTC")).toBe(true);
  });

  it("rejects invalid timezones", () => {
    expect(isIanaTimezone("Mars/Base")).toBe(false);
    expect(isIanaTimezone("")).toBe(false);
    expect(isIanaTimezone("PST8PDT-ish")).toBe(false);
  });

  it("requires at least one field", () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
    expect(updateProfileSchema.safeParse({ timezone: "Europe/London" }).success).toBe(true);
  });
});
