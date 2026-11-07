-- Before this change the scheduler stored a null "next due" date whenever the exam date left no
-- review day, and a null date is never due again. The date now holds the interval alone and the
-- exam is applied when it is read, so rebuild the missing dates from the interval. Only rows that
-- are learning or reviewing with a null date are touched; attempts are not.
--
--   reviewing: the interval at the row's step (clamped to the policy's last), counted in local
--              calendar days from the last independent success.
--   learning:  one local day after the attempt that put the row there (last_attempt_id), not an
--              older independent success.
--
-- A row whose timezone, policy or anchor cannot be used is left alone and reported as a warning.
UPDATE "review_states" AS rs
SET "next_due_at" = (
  (((fix.anchor AT TIME ZONE fix.tz)::date + fix.days)::timestamp) AT TIME ZONE fix.tz
)
FROM (
  SELECT
    r."id" AS id,
    u."timezone" AS tz,
    CASE r."state"
      WHEN 'reviewing' THEN COALESCE(r."last_independent_success_at", a."submitted_at", r."updated_at")
      ELSE COALESCE(a."submitted_at", r."updated_at")
    END AS anchor,
    CASE r."state"
      WHEN 'reviewing' THEN (
        p."config"->'intervalsDays'->>LEAST(
          r."step_index",
          jsonb_array_length(p."config"->'intervalsDays') - 1
        )
      )::int
      ELSE 1
    END AS days
  FROM "review_states" r
  JOIN "user" u ON u."id" = r."user_id"
  JOIN "scheduler_policies" p ON p."version" = r."policy_version"
  LEFT JOIN "attempts" a ON a."id" = r."last_attempt_id"
  WHERE r."next_due_at" IS NULL
    AND r."state" IN ('learning', 'reviewing')
    AND EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z."name" = u."timezone")
    AND (
      r."state" = 'learning'
      OR (
        jsonb_typeof(p."config"->'intervalsDays') = 'array'
        AND jsonb_array_length(p."config"->'intervalsDays') > 0
      )
    )
) AS fix
WHERE rs."id" = fix.id
  AND rs."next_due_at" IS NULL
  AND fix.anchor IS NOT NULL
  AND fix.days IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  skipped integer;
BEGIN
  SELECT count(*) INTO skipped
  FROM "review_states"
  WHERE "next_due_at" IS NULL AND "state" IN ('learning', 'reviewing');
  IF skipped > 0 THEN
    RAISE WARNING 'repair_null_review_due_dates: % learning/reviewing row(s) still have no due date (unusable timezone, policy or anchor)', skipped;
  END IF;
END $$;
