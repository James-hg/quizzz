CREATE TABLE "content_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"check_name" text NOT NULL,
	"result" text NOT NULL,
	"validator_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_checks_result_chk" CHECK ("content_checks"."result" in ('pass', 'fail', 'not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "content_review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_revision_id" uuid NOT NULL,
	"check_run_id" uuid,
	"reviewer_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"conflict_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_review_decisions_decision_chk" CHECK ("content_review_decisions"."decision" in ('approve', 'reject')),
	CONSTRAINT "content_review_decisions_reason_chk" CHECK ("content_review_decisions"."conflict_reason" is null or char_length("content_review_decisions"."conflict_reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "question_source_links" ADD COLUMN "excerpt" text;--> statement-breakpoint
ALTER TABLE "content_checks" ADD CONSTRAINT "content_checks_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_decisions" ADD CONSTRAINT "content_review_decisions_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_decisions" ADD CONSTRAINT "content_review_decisions_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_checks_revision_idx" ON "content_checks" USING btree ("question_revision_id","created_at");--> statement-breakpoint
CREATE INDEX "content_checks_run_idx" ON "content_checks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "content_review_decisions_revision_idx" ON "content_review_decisions" USING btree ("question_revision_id");