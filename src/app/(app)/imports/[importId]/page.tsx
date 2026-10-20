import type { Metadata } from "next";
import Link from "next/link";
import { ImportReview } from "@/components/ImportReview";
import type { ImportView } from "@/lib/client/types";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getCourse } from "@/server/content/courses";
import { listQuestionSetsWithCounts } from "@/server/content/overview";
import { getDb } from "@/server/db";
import { getImport } from "@/server/import/drafts";

export const metadata: Metadata = { title: "Review import · Quizzz" };
export const dynamic = "force-dynamic";

export default async function ImportReviewPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const user = await requirePageUser();
  const db = getDb();
  const importId = await idParam(params, "importId");
  const draft = await orNotFound(getImport(db, user.id, importId));
  const course = await getCourse(db, user.id, draft.courseId);
  const sets = await listQuestionSetsWithCounts(db, user.id, draft.courseId);
  // Dates become strings across the server/client boundary; the view type reflects that.
  const initial = JSON.parse(JSON.stringify(draft)) as ImportView;

  return (
    <div className="stack">
      <p className="crumbs">
        <Link href="/">Home</Link> / <Link href={`/courses/${course.id}`}>{course.title}</Link> /
        Review import
      </p>
      <ImportReview
        initial={initial}
        existingSets={sets.map((s) => ({ id: s.id, title: s.title }))}
        defaultTitle={draft.source?.filename.replace(/\.[^.]+$/, "") ?? "Imported questions"}
      />
    </div>
  );
}
