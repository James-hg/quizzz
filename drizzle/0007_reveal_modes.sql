CREATE TYPE "public"."reveal_mode" AS ENUM('each', 'end', 'requeue');--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "pass" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD COLUMN "reveal_mode" "reveal_mode" DEFAULT 'each' NOT NULL;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD COLUMN "retry_order" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_session_question_pass_uq" UNIQUE("session_id","question_id","pass");