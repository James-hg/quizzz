CREATE TABLE "question_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_images_storage_key_uq" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "question_revision_images" (
	"question_revision_id" uuid PRIMARY KEY NOT NULL,
	"image_id" uuid NOT NULL,
	"alt_text" text NOT NULL,
	CONSTRAINT "question_revision_images_alt_length" CHECK (char_length("question_revision_images"."alt_text") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "question_images" ADD CONSTRAINT "question_images_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_revision_images" ADD CONSTRAINT "question_revision_images_question_revision_id_question_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."question_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_revision_images" ADD CONSTRAINT "question_revision_images_image_id_question_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."question_images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_images_owner_id_idx" ON "question_images" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "question_revision_images_image_id_idx" ON "question_revision_images" USING btree ("image_id");--> statement-breakpoint
-- A revision's image link is part of what the student saw, so it is frozen once an attempt
-- references the revision. Editing a question writes a new revision and a new link instead.
CREATE FUNCTION "question_revision_images_guard_referenced"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "attempts" WHERE "question_revision_id" = OLD."question_revision_id") THEN
    RAISE EXCEPTION 'the image of question revision % cannot change because attempts reference it', OLD."question_revision_id";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "question_revision_images_guard_referenced"
BEFORE UPDATE OR DELETE ON "question_revision_images"
FOR EACH ROW EXECUTE FUNCTION "question_revision_images_guard_referenced"();
