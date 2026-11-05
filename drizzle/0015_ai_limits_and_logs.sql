CREATE TABLE "ai_call_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"model" text,
	"method" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"outcome" text DEFAULT 'started' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_provider_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"quota_error_streak" integer DEFAULT 0 NOT NULL,
	"last_quota_error_at" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"probe_lease_id" uuid,
	CONSTRAINT "ai_provider_state_singleton" CHECK ("ai_provider_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ai_rate_windows" (
	"subject" text NOT NULL,
	"period" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_rate_windows_subject_period_window_start_pk" PRIMARY KEY("subject","period","window_start"),
	CONSTRAINT "ai_rate_windows_count_nonneg" CHECK ("ai_rate_windows"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_call_leases" ADD CONSTRAINT "ai_call_leases_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_call_leases_expires_at_idx" ON "ai_call_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ai_call_logs_user_started_idx" ON "ai_call_logs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_call_logs_started_idx" ON "ai_call_logs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "ai_rate_windows_window_start_idx" ON "ai_rate_windows" USING btree ("window_start");