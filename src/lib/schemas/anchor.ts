import { z } from "zod";

/** Locates a source segment inside its document. At least one locator is required. */
export const anchorSchema = z
  .object({
    page: z.number().int().positive().optional(),
    slide: z.number().int().positive().optional(),
    paragraphIndex: z.number().int().nonnegative().optional(),
    headingPath: z.array(z.string()).optional(),
  })
  .refine((anchor) => Object.values(anchor).some((value) => value !== undefined), {
    message: "anchor needs at least one locator",
  });

export type Anchor = z.infer<typeof anchorSchema>;
