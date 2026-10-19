import { z } from "zod";

/** Server-only in scored practice: never sent to the browser before submission. */
export const answerKeySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("options"),
    correctOptionIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("text"),
    accepted: z.array(z.string()).min(1),
    caseSensitive: z.boolean().default(false),
  }),
  // Imported questions whose correct answer could not be determined. Never gradable.
  z.object({ kind: z.literal("unresolved") }),
  z.object({
    kind: z.literal("blanks"),
    blanks: z.array(z.array(z.string()).min(1)).min(1),
    caseSensitive: z.boolean().default(false),
  }),
]);

export type AnswerKey = z.infer<typeof answerKeySchema>;
