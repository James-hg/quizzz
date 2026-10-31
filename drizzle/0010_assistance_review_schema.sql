CREATE TYPE "public"."assistance_level" AS ENUM('none', 'conceptual_hint', 'next_step_hint', 'partial_example', 'full_explanation', 'solution_revealed');--> statement-breakpoint
CREATE TYPE "public"."help_action" AS ENUM('small_hint', 'explain_step', 'why_wrong', 'similar_example', 'full_explanation');--> statement-breakpoint
CREATE TYPE "public"."hint_origin" AS ENUM('owner', 'ai_proposed', 'sample');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('new', 'learning', 'reviewing', 'suspended');--> statement-breakpoint
CREATE TABLE "scheduler_policies" (
	"version" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approved_hints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"level" "assistance_level" NOT NULL,
	"text" text NOT NULL,
	"source_segment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"origin" "hint_origin" NOT NULL,
	"evidence_status" "evidence_status" DEFAULT 'unresolved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approved_hints_revision_level_uq" UNIQUE("question_revision_id","level"),
	CONSTRAINT "approved_hints_level_chk" CHECK ("approved_hints"."level" in ('conceptual_hint', 'next_step_hint', 'partial_example', 'full_explanation'))
);
--> statement-breakpoint
CREATE TABLE "concept_evidence" (
	"user_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"independent_correct" integer DEFAULT 0 NOT NULL,
	"assisted_correct" integer DEFAULT 0 NOT NULL,
	"new_problem_checks" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone,
	CONSTRAINT "concept_evidence_user_concept_uq" UNIQUE("user_id","concept_id"),
	CONSTRAINT "concept_evidence_counts_chk" CHECK ("concept_evidence"."independent_correct" >= 0 and "concept_evidence"."assisted_correct" >= 0 and "concept_evidence"."new_problem_checks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepts_course_name_uq" UNIQUE("course_id","name")
);
--> statement-breakpoint
CREATE TABLE "help_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"pass" smallint DEFAULT 1 NOT NULL,
	"action" "help_action" NOT NULL,
	"level" "assistance_level" NOT NULL,
	"approved_hint_id" uuid,
	"content_text" text,
	"source_segment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"latency_ms" integer,
	"attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_events_pass_chk" CHECK ("help_events"."pass" in (1, 2)),
	CONSTRAINT "help_events_level_chk" CHECK ("help_events"."level" in ('conceptual_hint', 'next_step_hint', 'partial_example', 'full_explanation')),
	CONSTRAINT "help_events_content_chk" CHECK ("help_events"."approved_hint_id" is not null or "help_events"."content_text" is not null)
);
--> statement-breakpoint
CREATE TABLE "review_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"state" "review_state" DEFAULT 'new' NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"next_due_at" timestamp with time zone,
	"last_independent_success_at" timestamp with time zone,
	"delayed_success_count" integer DEFAULT 0 NOT NULL,
	"distinct_success_days" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"policy_version" text DEFAULT 'v1' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_states_counts_chk" CHECK ("review_states"."step_index" >= 0 and "review_states"."delayed_success_count" >= 0 and "review_states"."distinct_success_days" >= 0 and "review_states"."lapses" >= 0)
);
--> statement-breakpoint
-- Scheduler policy v1, seeded before anything references it. These are product parameters, not
-- scientific claims: one in-session retry, reviews after 1, 3, 7 and 14 days, a correct answer
-- that used help does not advance the schedule, and a lapse steps back one interval.
INSERT INTO "scheduler_policies" ("version", "config") VALUES (
  'v1',
  '{"inSessionRetry":{"maxRetries":1},"intervalsDays":[1,3,7,14],"assistedAdvances":false,"onLapse":{"stepBack":1}}'::jsonb
)
ON CONFLICT ("version") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "assistance_level" "assistance_level" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "approved_hints" ADD CONSTRAINT "approved_hints_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_evidence" ADD CONSTRAINT "concept_evidence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_evidence" ADD CONSTRAINT "concept_evidence_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_approved_hint_id_approved_hints_id_fk" FOREIGN KEY ("approved_hint_id") REFERENCES "public"."approved_hints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_policy_version_scheduler_policies_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."scheduler_policies"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concepts_owner_id_idx" ON "concepts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "help_events_turn_idx" ON "help_events" USING btree ("session_id","question_id","pass");--> statement-breakpoint
CREATE INDEX "help_events_user_id_idx" ON "help_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "help_events_attempt_id_idx" ON "help_events" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_states_user_question_uq" ON "review_states" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX "review_states_due_idx" ON "review_states" USING btree ("user_id","next_due_at");--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_policy_version_scheduler_policies_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."scheduler_policies"("version") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- A help event is evidence of what a student was shown, so it is recorded once. The only change
-- allowed afterwards is linking it to the attempt it preceded, one time, and only to an attempt
-- of the same user, session, question and turn.
CREATE FUNCTION "help_events_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."attempt_id" IS NOT NULL
       OR (to_jsonb(NEW) - 'attempt_id') IS DISTINCT FROM (to_jsonb(OLD) - 'attempt_id') THEN
      RAISE EXCEPTION 'help events cannot be changed once recorded';
    END IF;
  END IF;
  IF NEW."attempt_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "attempts" a
    WHERE a."id" = NEW."attempt_id"
      AND a."user_id" = NEW."user_id"
      AND a."session_id" = NEW."session_id"
      AND a."question_id" = NEW."question_id"
      AND a."pass" = NEW."pass"
  ) THEN
    RAISE EXCEPTION 'help event does not match the attempt it is linked to';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "help_events_guard"
BEFORE INSERT OR UPDATE ON "help_events"
FOR EACH ROW EXECUTE FUNCTION "help_events_guard"();
