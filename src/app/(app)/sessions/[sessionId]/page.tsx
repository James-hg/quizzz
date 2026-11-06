import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlayScreen } from "@/components/play/PlayScreen";
import type { PlaySession } from "@/lib/client/types";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getCourse } from "@/server/content/courses";
import { getDb } from "@/server/db";
import { getSession } from "@/server/sessions/service";

export const metadata: Metadata = { title: "Today's session · Quizzz" };
export const dynamic = "force-dynamic";

type Params = Promise<{ sessionId: string }>;

/**
 * A planned review or exam session over a whole course. The course comes from the session the
 * user owns, never from the address. Reloading resumes exactly where the student was, and an
 * ended session shows its results. Single-set practice keeps its own route.
 */
export default async function CourseSessionPage({ params }: { params: Params }) {
  const user = await requirePageUser();
  const db = getDb();
  const sessionId = await idParam(params, "sessionId");
  const session = await orNotFound(getSession(db, user.id, sessionId));
  if (session.questionSetId !== null) notFound();
  const course = await orNotFound(getCourse(db, user.id, session.courseId));
  const initial = JSON.parse(JSON.stringify(session)) as PlaySession;
  return <PlayScreen initial={initial} setTitle={course.title} />;
}
