import { forbidden } from "@/server/http/errors";

/**
 * Whether help (hints, explanations) may be given in a session. Practice exams allow none: the
 * point is to find out what you can do unaided. The tutor's help endpoint (B5) must call this
 * before doing anything else.
 */
export function assertHelpAllowed(session: { mode: string }): void {
  if (session.mode === "exam") {
    throw forbidden("Hints are turned off in a practice exam.", "help_disabled_in_exam");
  }
}
