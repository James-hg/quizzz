import { z } from "zod";

export const optionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1),
});

export const optionsSchema = z
  .array(optionSchema)
  .refine((options) => new Set(options.map((o) => o.id)).size === options.length, {
    message: "option ids must be unique",
  });

export type Option = z.infer<typeof optionSchema>;
