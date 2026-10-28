import { pgEnum } from "drizzle-orm/pg-core";

export const courseLanguage = pgEnum("course_language", [
  "python",
  "java",
  "c",
  "cpp",
  "javascript",
]);
export const questionSetOrigin = pgEnum("question_set_origin", ["imported", "manual", "sample"]);
export const questionStatus = pgEnum("question_status", ["active", "excluded", "reported"]);
export const questionType = pgEnum("question_type", [
  "mcq_single",
  "mcq_multi",
  "short_answer",
  "fill_blank",
  "output_prediction",
]);
export const revisionOrigin = pgEnum("revision_origin", [
  "original",
  "ai_proposed",
  "ai_variant",
  "sample",
]);
export const evidenceStatus = pgEnum("evidence_status", [
  "unresolved",
  "generated_unreviewed",
  "source_linked",
  "deterministically_checked",
  "human_reviewed",
  "needs_review",
  "rejected",
]);
export const segmentKind = pgEnum("segment_kind", [
  "heading",
  "paragraph",
  "list_item",
  "table",
  "slide",
  "page",
]);
export const linkRelationship = pgEnum("link_relationship", ["origin", "evidence"]);
export const sessionMode = pgEnum("session_mode", ["quiz", "review", "learn", "mixed", "exam"]);
export const revealMode = pgEnum("reveal_mode", ["each", "end", "requeue"]);
export const sessionState = pgEnum("session_state", ["active", "paused", "completed", "abandoned"]);
export const gradingOutcome = pgEnum("grading_outcome", ["correct", "incorrect", "uncertain"]);
export const activityRole = pgEnum("activity_role", ["scored", "prequestion", "practice"]);
