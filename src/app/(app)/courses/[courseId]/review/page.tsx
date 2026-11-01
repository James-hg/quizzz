import type { Metadata } from "next";
import Link from "next/link";
import { ReviewQueue } from "@/components/review/ReviewQueue";
import type { ReviewQueueView } from "@/lib/client/types";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getReviewQueue } from "@/server/content-checks/review";
import { getCourse } from "@/server/content/courses";
import { getDb } from "@/server/db";

export const metadata: Metadata = { title: "Review queue · Quizzz" };
export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requirePageUser();
  const db = getDb();
  const courseId = await idParam(params, "courseId");
  const course = await orNotFound(getCourse(db, user.id, courseId));
  const queue = await orNotFound(getReviewQueue(db, user.id, courseId));
  // Dates become strings across the server/client boundary.
  const initial = JSON.parse(JSON.stringify(queue)) as ReviewQueueView;

  return (
    <div className="stack">
      <p className="crumbs">
        <Link href="/">Home</Link> / <Link href={`/courses/${course.id}`}>{course.title}</Link> /
        Review
      </p>
      <div className="page-head">
        <div>
          <h1>Review queue</h1>
          <p className="muted">
            AI-proposed and sample questions stay out of practice until you approve them. Approving
            records that you checked them, not that they are proven correct.
          </p>
        </div>
      </div>
      <ReviewQueue courseId={course.id} queue={initial} />
    </div>
  );
}
