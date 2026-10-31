ALTER TABLE "review_states" ADD COLUMN "last_reason" text;--> statement-breakpoint
ALTER TABLE "review_states" ADD COLUMN "last_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_last_attempt_id_attempts_id_fk" FOREIGN KEY ("last_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;