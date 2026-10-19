import { z } from "zod";

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.length > 0 && Intl.supportedValuesOf("timeZone").concat("UTC").includes(value);
  } catch {
    return false;
  }
}

export const timezoneSchema = z.string().refine(isIanaTimezone, "must be an IANA timezone");

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    email: z.email().max(254).optional(),
    timezone: timezoneSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "at least one field is required");

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
