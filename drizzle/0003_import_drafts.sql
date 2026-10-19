CREATE TYPE "public"."import_decision" AS ENUM('pending', 'accepted', 'edited', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."import_item_kind" AS ENUM('question', 'material');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('extracted', 'reviewing', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "import_draft_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "import_item_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"item_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" "import_decision" DEFAULT 'pending' NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "import_draft_items_position_uq" UNIQUE("draft_id","position")
);
--> statement-breakpoint
CREATE TABLE "import_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"status" "import_status" DEFAULT 'extracted' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"published_question_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_draft_items" ADD CONSTRAINT "import_draft_items_draft_id_import_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."import_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_published_question_set_id_question_sets_id_fk" FOREIGN KEY ("published_question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_drafts_owner_id_idx" ON "import_drafts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "import_drafts_course_id_idx" ON "import_drafts" USING btree ("course_id");