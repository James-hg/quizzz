import Link from "next/link";
import {
  editorHref,
  explainNotPlayable,
  filterToFix,
  type PlayabilityCounts,
} from "@/lib/playability";
import { Alert } from "./ui/Alert";

type Props = { questionSetId: string; counts: PlayabilityCounts };

/** Says why nothing can be practised yet, from server counts, and links to the fix. */
export function PracticeBlockedNotice({ questionSetId, counts }: Props) {
  const message = explainNotPlayable(counts);
  if (!message) return null;
  return (
    <Alert tone="warning">
      {message}{" "}
      {counts.total > 0 ? (
        <Link href={editorHref(questionSetId, filterToFix(counts))}>Review them in the editor</Link>
      ) : (
        <Link href={editorHref(questionSetId, "all")}>Add questions in the editor</Link>
      )}
    </Alert>
  );
}

/** Shown when some questions can be practised but others are waiting for review. */
export function NeedsReviewNote({ questionSetId, counts }: Props) {
  if (counts.playable === 0 || counts.needsReview === 0) return null;
  return (
    <p className="small muted">
      {counts.needsReview} {counts.needsReview === 1 ? "question needs" : "questions need"} review
      before {counts.needsReview === 1 ? "it" : "they"} can be practised.{" "}
      <Link href={editorHref(questionSetId, "needs-review")}>Review</Link>
    </p>
  );
}
