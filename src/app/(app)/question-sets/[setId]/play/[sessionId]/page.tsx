import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlayScreen } from "@/components/play/PlayScreen";
import type { PlaySession } from "@/lib/client/types";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getQuestionSet } from "@/server/content/question-sets";
import { getDb } from "@/server/db";
import { getSession } from "@/server/sessions/service";

export const metadata: Metadata = { title: "Practice · Quizzz" };
export const dynamic = "force-dynamic";

type Params = Promise<{ setId: string; sessionId: string }>;

/**
 * Loads the session from the database on every visit, so reloading mid-session resumes exactly
 * where the student was. The session view never contains answer keys for unanswered questions.
 */
export default async function PlayPage({ params }: { params: Params }) {
  const user = await requirePageUser();
  const db = getDb();
  const setId = await idParam(params, "setId");
  const sessionId = await idParam(params, "sessionId");
  const session = await orNotFound(getSession(db, user.id, sessionId));
  if (session.questionSetId !== setId) notFound();
  const set = await orNotFound(getQuestionSet(db, user.id, setId));
  const initial = JSON.parse(JSON.stringify(session)) as PlaySession;
  return <PlayScreen initial={initial} setTitle={set.title} />;
}
