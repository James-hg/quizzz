import { z } from "zod";

export const responseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("options"), selectedOptionIds: z.array(z.string().min(1)) }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("blanks"), values: z.array(z.string()) }),
]);

export type QuestionResponse = z.infer<typeof responseSchema>;
