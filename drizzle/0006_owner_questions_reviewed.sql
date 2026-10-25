-- A20: a question the owner wrote (origin 'original') with a resolved answer counts as reviewed.
-- 'unresolved' now means only "the answer is missing". This repairs rows saved before that rule,
-- when every owner question without the approve tick was labelled 'unresolved'.
--
-- Only evidence_status changes: attempts, prompts, options, keys and every other revision column
-- are untouched. Safe to run more than once, because the second run matches no rows.
UPDATE "question_revisions"
SET "evidence_status" = 'human_reviewed'
WHERE "origin" = 'original'
  AND "evidence_status" = 'unresolved'
  AND "answer_key"->>'kind' <> 'unresolved';
