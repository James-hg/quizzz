CREATE TYPE "public"."rewrite_mode" AS ENUM('rephrase', 'vary_numbers', 'add_explanation');--> statement-breakpoint
CREATE TYPE "public"."rewrite_status" AS ENUM('pending', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TABLE "question_rewrites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"mode" "rewrite_mode" NOT NULL,
	"content" jsonb NOT NULL,
	"origin" "revision_origin" NOT NULL,
	"evidence_status" "evidence_status" NOT NULL,
	"status" "rewrite_status" DEFAULT 'pending' NOT NULL,
	"result_question_id" uuid,
	"result_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "question_rewrites" ADD CONSTRAINT "question_rewrites_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_rewrites" ADD CONSTRAINT "question_rewrites_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_rewrites" ADD CONSTRAINT "question_rewrites_base_revision_id_question_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_rewrites" ADD CONSTRAINT "question_rewrites_result_question_id_questions_id_fk" FOREIGN KEY ("result_question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_rewrites" ADD CONSTRAINT "question_rewrites_result_revision_id_question_revisions_id_fk" FOREIGN KEY ("result_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_rewrites_question_status_idx" ON "question_rewrites" USING btree ("question_id","status");--> statement-breakpoint
CREATE INDEX "question_rewrites_owner_id_idx" ON "question_rewrites" USING btree ("owner_id");