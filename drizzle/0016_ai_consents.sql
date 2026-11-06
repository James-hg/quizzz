CREATE TABLE "ai_consents" (
	"user_id" uuid NOT NULL,
	"notice_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_consents_user_id_notice_version_pk" PRIMARY KEY("user_id","notice_version")
);
--> statement-breakpoint
ALTER TABLE "ai_consents" ADD CONSTRAINT "ai_consents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;