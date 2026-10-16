CREATE TYPE "public"."activity_role" AS ENUM('scored', 'prequestion', 'practice');--> statement-breakpoint
CREATE TYPE "public"."course_language" AS ENUM('python', 'java', 'c', 'cpp', 'javascript');--> statement-breakpoint
CREATE TYPE "public"."evidence_status" AS ENUM('unresolved', 'generated_unreviewed', 'source_linked', 'deterministically_checked', 'human_reviewed', 'needs_review', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."grading_outcome" AS ENUM('correct', 'incorrect', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."link_relationship" AS ENUM('origin', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."question_set_origin" AS ENUM('imported', 'manual', 'sample');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('active', 'excluded', 'reported');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('mcq_single', 'mcq_multi', 'short_answer', 'fill_blank', 'output_prediction');--> statement-breakpoint
CREATE TYPE "public"."revision_origin" AS ENUM('original', 'ai_proposed', 'ai_variant', 'sample');--> statement-breakpoint
CREATE TYPE "public"."segment_kind" AS ENUM('heading', 'paragraph', 'list_item', 'table', 'slide', 'page');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('quiz', 'review', 'learn', 'mixed', 'exam');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('active', 'paused', 'completed', 'abandoned');--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"subject" text NOT NULL,
	"language" "course_language",
	"exam_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"type" "question_type" NOT NULL,
	"prompt" text NOT NULL,
	"code_snippet" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer_key" jsonb NOT NULL,
	"explanation" text,
	"origin" "revision_origin" NOT NULL,
	"evidence_status" "evidence_status" DEFAULT 'unresolved' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_revisions_question_number_uq" UNIQUE("question_id","revision_number")
);
--> statement-breakpoint
CREATE TABLE "question_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"origin" "question_set_origin" NOT NULL,
	"source_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_source_links" (
	"question_revision_id" uuid NOT NULL,
	"source_segment_id" uuid NOT NULL,
	"relationship" "link_relationship" NOT NULL,
	CONSTRAINT "question_source_links_question_revision_id_source_segment_id_relationship_pk" PRIMARY KEY("question_revision_id","source_segment_id","relationship")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_set_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"current_revision_id" uuid,
	"status" "question_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"is_correct" boolean,
	"grading_outcome" "grading_outcome" NOT NULL,
	"activity_role" "activity_role" DEFAULT 'scored' NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempts_user_idempotency_uq" UNIQUE("user_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "study_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"question_set_id" uuid,
	"mode" "session_mode" NOT NULL,
	"state" "session_state" DEFAULT 'active' NOT NULL,
	"time_budget_minutes" integer,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"active_started_at" timestamp with time zone,
	"current_index" integer DEFAULT 0 NOT NULL,
	"item_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_version" text DEFAULT 'v1' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "segment_kind" NOT NULL,
	"text" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_segments_doc_ordinal_uq" UNIQUE("source_document_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "question_revisions" ADD CONSTRAINT "question_revisions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_source_links" ADD CONSTRAINT "question_source_links_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_source_links" ADD CONSTRAINT "question_source_links_source_segment_id_source_segments_id_fk" FOREIGN KEY ("source_segment_id") REFERENCES "public"."source_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_current_revision_id_question_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_segments" ADD CONSTRAINT "source_segments_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courses_owner_id_idx" ON "courses" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "question_revisions_question_id_idx" ON "question_revisions" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_sets_course_id_idx" ON "question_sets" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "question_sets_owner_id_idx" ON "question_sets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "question_source_links_segment_idx" ON "question_source_links" USING btree ("source_segment_id");--> statement-breakpoint
CREATE INDEX "questions_question_set_id_idx" ON "questions" USING btree ("question_set_id");--> statement-breakpoint
CREATE INDEX "attempts_session_id_idx" ON "attempts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "attempts_question_id_idx" ON "attempts" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "attempts_question_revision_id_idx" ON "attempts" USING btree ("question_revision_id");--> statement-breakpoint
CREATE INDEX "study_sessions_user_id_idx" ON "study_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "study_sessions_course_id_idx" ON "study_sessions" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "source_documents_owner_id_idx" ON "source_documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "source_documents_course_id_idx" ON "source_documents" USING btree ("course_id");
--> statement-breakpoint
-- Revisions are immutable once an attempt references them. Editing a question creates a new
-- revision. Only evidence_status may change later (review workflow); content columns may not.
CREATE FUNCTION "question_revisions_guard_referenced"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "attempts" WHERE "question_revision_id" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'question revision % is referenced by attempts and cannot be deleted', OLD."id";
  END IF;
  IF NEW."question_id" IS DISTINCT FROM OLD."question_id"
    OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."prompt" IS DISTINCT FROM OLD."prompt"
    OR NEW."code_snippet" IS DISTINCT FROM OLD."code_snippet"
    OR NEW."options" IS DISTINCT FROM OLD."options"
    OR NEW."answer_key" IS DISTINCT FROM OLD."answer_key"
    OR NEW."explanation" IS DISTINCT FROM OLD."explanation"
    OR NEW."origin" IS DISTINCT FROM OLD."origin"
  THEN
    RAISE EXCEPTION 'question revision % is referenced by attempts and is immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "question_revisions_guard_referenced"
BEFORE UPDATE OR DELETE ON "question_revisions"
FOR EACH ROW EXECUTE FUNCTION "question_revisions_guard_referenced"();
--> statement-breakpoint
-- Attempts are never rewritten. Deletion is blocked by FK restrict on questions/revisions;
-- account deletion (E3) is the only intended path that removes them.
CREATE FUNCTION "attempts_no_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'attempts cannot be updated';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "attempts_no_update"
BEFORE UPDATE ON "attempts"
FOR EACH ROW EXECUTE FUNCTION "attempts_no_update"();
