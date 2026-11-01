import "server-only";
import { and, desc, eq } from "drizzle-orm";
import {
  HELP_ACTION_LEVEL,
  assistanceRank,
  helpEventInputSchema,
  hintLevelSchema,
  tutorOutputSchema,
  type HelpCitation,
  type HelpRequest,
  type HelpResponse,
} from "@/lib/schemas";
import { chargeAiQuota, requireAi } from "@/server/ai/guard";
import { DEFAULT_GEMINI_MODEL } from "@/server/ai";
import { AiInvalidOutput, AiUnavailable } from "@/server/ai/errors";
import { DATA_NOT_INSTRUCTIONS, delimitData } from "@/server/ai/prompt";
import { requireUser } from "@/server/auth/session";
import type { Database } from "@/server/db";
import { parseRevisionJson } from "@/server/db/repositories/questions";
import {
  approvedHints,
  attempts,
  helpEvents,
  questionRevisions,
  studySessions,
} from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { ApiError, conflict, forbidden, notFound } from "@/server/http/errors";
import { loadImagesForRevisions } from "@/server/images/service";
import {
  findRelevantSegments,
  getOwnedSegment,
  type CitationSegment,
} from "@/server/retrieval/segments";
import { assertHelpAllowed } from "@/server/sessions/guards";
import { disclosureFor, type Pass } from "@/server/sessions/reveal";
import { lockSession } from "@/server/sessions/service";
import { firstPendingIndex, sessionSlots } from "@/server/sessions/view";
import { leaksAnswer } from "./leak";

/**
 * Help for the exact question and turn a student is on. The browser says which question and
 * which kind of help; the server decides the turn, the level, and what may be shown. Help is
 * recorded as an immutable event before the answer, and the answer path (submitAnswer) picks it
 * up, so help changes how the attempt is scheduled without ever editing an attempt.
 *
 * Generated text is a proposal: it is validated and checked before it is shown or stored. When
 * the model cannot be used, a reviewed hint for the same pinned revision is served instead.
 */

export const TUTOR_PROMPT_VERSION = "tutor-v1";
const MAX_PASSAGES = 5;
const MAX_PASSAGE_CHARS = 6_000;
const TIMEOUT_MS = 25_000;

type Hint = typeof approvedHints.$inferSelect;
type Revision = typeof questionRevisions.$inferSelect;
type Level = (typeof HELP_ACTION_LEVEL)[HelpRequest["action"]];

/** Everything decided about one request before any model is involved. */
type Turn = {
  userId: string;
  session: typeof studySessions.$inferSelect;
  revision: Revision;
  questionId: string;
  pass: Pass;
  action: HelpRequest["action"];
  /** A wrong first answer whose retry is pending: its correct answer is still hidden. */
  protectedRetry: boolean;
  /** The student's latest wrong response, for "why was I wrong". */
  priorWrong: unknown;
};

const hrefFor = (segmentId: string) => `/api/sources/segments/${segmentId}`;

async function resolveTurn(
  db: Database,
  userId: string,
  sessionId: string,
  input: HelpRequest,
  lock = false,
): Promise<Turn> {
  const session = lock
    ? await lockSession(db, userId, sessionId)
    : (
        await db
          .select()
          .from(studySessions)
          .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId)))
      )[0];
  if (!session) throw notFound("Session not found");

  assertHelpAllowed(session);
  if (session.state === "completed" || session.state === "abandoned") {
    throw conflict("This session has ended.", "session_completed");
  }
  if (session.state === "paused") {
    throw conflict("This session is paused. Resume it to ask for help.", "session_paused");
  }

  const sessionAttempts = await db.select().from(attempts).where(eq(attempts.sessionId, sessionId));
  const done = new Set(sessionAttempts.map((a) => `${a.questionId}:${a.pass}`));
  const slots = sessionSlots(session);
  const index = firstPendingIndex(
    slots.map((slot) => ({
      status:
        done.has(`${slot.questionId}:${slot.pass}`) || !session.revisionIds[slot.questionId]
          ? "done"
          : "pending",
    })),
  );
  const current = slots[index];
  if (!current || current.questionId !== input.questionId) {
    throw conflict("That is not the question you are on now.", "stale_turn");
  }

  const [row] = await db
    .select()
    .from(questionRevisions)
    .where(eq(questionRevisions.id, session.revisionIds[current.questionId] ?? ""));
  if (!row) throw conflict("This question was removed from the set.", "question_removed");
  const revision = parseRevisionJson(row);

  const first = sessionAttempts.find((a) => a.questionId === current.questionId && a.pass === 1);
  const protectedRetry =
    current.pass === 2 &&
    first !== undefined &&
    disclosureFor({
      mode: session.revealMode,
      sessionEnded: false,
      pass: 1,
      outcome: first.gradingOutcome,
      retryAnswered: false,
    }) !== "full";
  // Until the retry is answered the correct answer is hidden, so help that could state it waits.
  if (protectedRetry && input.action !== "small_hint" && input.action !== "why_wrong") {
    throw forbidden(
      "Only a small hint or help with your mistake is available until you have tried again.",
      "help_not_available_yet",
    );
  }

  let priorWrong: unknown = null;
  if (input.action === "why_wrong") {
    const [wrong] = await db
      .select({ response: attempts.response })
      .from(attempts)
      .where(
        and(
          eq(attempts.userId, userId),
          eq(attempts.questionId, current.questionId),
          eq(attempts.gradingOutcome, "incorrect"),
        ),
      )
      .orderBy(desc(attempts.submittedAt))
      .limit(1);
    if (!wrong) {
      throw conflict("You have not answered this question wrongly yet.", "no_wrong_answer");
    }
    priorWrong = wrong.response;
  }

  return {
    userId,
    session,
    revision,
    questionId: current.questionId,
    pass: current.pass,
    action: input.action,
    protectedRetry,
    priorWrong,
  };
}

/** Whether the shown text must stop short of the answer. */
const mustNotLeak = (turn: Turn) => turn.action === "small_hint" || turn.protectedRetry;

const leaks = (turn: Turn, text: string) =>
  mustNotLeak(turn) && leaksAnswer(text, turn.revision.answerKey, turn.revision.options);

function toCitations(segments: CitationSegment[]): HelpCitation[] {
  return segments.map((s) => ({
    segmentId: s.id,
    href: hrefFor(s.id),
    filename: s.filename,
    location: s.location,
  }));
}

// ---------------------------------------------------------------- reviewed (approved) hints

/**
 * A reviewed hint for this pinned revision at `wanted` strength or weaker, strongest first. Its
 * cited passages must still be readable by this student, and it must pass the same leak check.
 */
async function approvedHintFor(
  db: Database,
  turn: Turn,
  wanted: Level,
  exactOnly: boolean,
): Promise<{ hint: Hint; segments: CitationSegment[] } | null> {
  const rows = await db
    .select()
    .from(approvedHints)
    .where(
      and(
        eq(approvedHints.questionRevisionId, turn.revision.id),
        eq(approvedHints.evidenceStatus, "human_reviewed"),
      ),
    );
  const candidates = rows
    .filter((h) =>
      exactOnly ? h.level === wanted : assistanceRank(h.level) <= assistanceRank(wanted),
    )
    .sort((a, b) => assistanceRank(b.level) - assistanceRank(a.level));

  for (const hint of candidates) {
    if (leaks(turn, hint.text)) continue;
    const segments: CitationSegment[] = [];
    let stale = false;
    for (const id of hint.sourceSegmentIds) {
      try {
        segments.push(await getOwnedSegment(db, turn.userId, id));
      } catch {
        stale = true;
        break;
      }
    }
    if (stale) continue;
    return { hint, segments };
  }
  return null;
}

// ---------------------------------------------------------------- generated help

const ACTION_GUIDANCE: Record<HelpRequest["action"], string> = {
  small_hint:
    "Give a small conceptual hint that points the student at the idea to use. Stop well short of the answer: never state the correct option, value or final result.",
  explain_step:
    "Explain the next step the student should take, without carrying out the whole solution.",
  why_wrong:
    "Explain what is likely wrong with the student's previous answer and what to reconsider. Do not state the correct answer.",
  similar_example:
    "Show a different, similar worked example (different numbers or wording), not this question's answer.",
  full_explanation:
    "Explain fully how to answer this question and why the correct answer is correct.",
};

async function passagesFor(db: Database, turn: Turn): Promise<CitationSegment[]> {
  // During a protected retry a source passage could itself state the answer, so none is used.
  if (turn.protectedRetry || !turn.session.courseId) return [];
  const query = [turn.revision.prompt, ...turn.revision.options.map((o) => o.text)]
    .join(" ")
    .slice(0, 2000);
  try {
    return await findRelevantSegments(db, {
      userId: turn.userId,
      courseId: turn.session.courseId,
      query,
      questionRevisionId: turn.revision.id,
      limit: MAX_PASSAGES,
      maxChars: MAX_PASSAGE_CHARS,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

function questionAsData(turn: Turn, imageAlt: string | null) {
  const r = turn.revision;
  return {
    type: r.type,
    prompt: r.prompt,
    code: r.codeSnippet ?? null,
    options: r.options,
    image: imageAlt === null ? null : { altText: imageAlt },
    // The tutor needs the key to guide well; the rules above keep it out of small hints.
    correctAnswer: r.answerKey,
    explanation: r.explanation ?? null,
  };
}

function buildPrompt(turn: Turn, passages: CitationSegment[], imageAlt: string | null) {
  const level = HELP_ACTION_LEVEL[turn.action];
  const system = [
    "You are a patient tutor helping a student with one practice question.",
    ACTION_GUIDANCE[turn.action],
    `Reply as JSON with "level" set to "${level}", "text" (plain text, at most 1500 characters), "citedSegmentIds", "sourceSupported" and optionally "uncertainty".`,
    "Cite a passage only by the id given with it, and only if the text really relies on it. If no passage supports what you say, use an empty citedSegmentIds and sourceSupported false, and say what you are unsure about in uncertainty.",
    imageAlt !== null
      ? "The question has a picture that you cannot see; you only have its description. If the question depends on detail the description lacks, say so in uncertainty and do not guess."
      : "",
    DATA_NOT_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join(" ");

  const parts = [delimitData("question", JSON.stringify(questionAsData(turn, imageAlt)), 20_000)];
  if (turn.action === "why_wrong") {
    parts.push(delimitData("previous answer", JSON.stringify(turn.priorWrong), 2_000));
  }
  for (const p of passages) {
    parts.push(
      delimitData(`passage ${p.id} from ${p.filename} ${p.location}`, p.text, MAX_PASSAGE_CHARS),
    );
  }
  return { system, prompt: parts.join("\n\n") };
}

type Generated = {
  text: string;
  citations: HelpCitation[];
  sourceSupported: boolean;
  uncertainty?: string;
  provider: string;
  model: string;
  latencyMs: number;
};

async function generate(db: Database, request: Request, turn: Turn): Promise<Generated> {
  const { user, provider } = await requireAi(request);
  const imageAlt =
    (await loadImagesForRevisions(db, [turn.revision.id])).get(turn.revision.id)?.alt ?? null;
  const passages = await passagesFor(db, turn);
  const { system, prompt } = buildPrompt(turn, passages, imageAlt);

  await chargeAiQuota(db, user.id);
  const started = Date.now();
  const output = await provider.generateStructured(prompt, tutorOutputSchema, {
    system,
    timeoutMs: TIMEOUT_MS,
    temperature: 0.3,
  });
  const latencyMs = Date.now() - started;

  // A proposal is only shown once it matches what was asked and keeps the answer back.
  if (output.level !== HELP_ACTION_LEVEL[turn.action]) throw new AiInvalidOutput();
  if (leaks(turn, output.text)) throw new AiInvalidOutput();

  // Only passages that were supplied for this request can be cited. Anything else is dropped
  // and the answer is no longer called source supported: a citation is never made up.
  const supplied = new Map(passages.map((p) => [p.id, p]));
  const valid = [...new Set(output.citedSegmentIds)].filter((id) => supplied.has(id));
  const sourceSupported = output.sourceSupported && valid.length > 0;
  const cited = sourceSupported ? valid.map((id) => supplied.get(id)!) : [];

  const dropped =
    output.citedSegmentIds.length > valid.length || (output.sourceSupported && !sourceSupported);
  const uncertainty = dropped
    ? [
        output.uncertainty,
        "Some cited sources could not be verified, so this is not marked as source supported.",
      ]
        .filter(Boolean)
        .join(" ")
    : output.uncertainty;

  return {
    text: output.text,
    citations: toCitations(cited),
    sourceSupported,
    ...(uncertainty ? { uncertainty } : {}),
    provider: provider.name,
    model: getEnv().GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    latencyMs,
  };
}

// ---------------------------------------------------------------- recording

type Shown = {
  level: Level;
  text: string;
  citations: HelpCitation[];
  sourceSupported: boolean;
  uncertainty?: string;
  origin: "approved" | "ai_proposed";
  servedAs: "requested" | "fallback_hint";
  approvedHintId?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
};

/**
 * Stores what was shown, in a short transaction that re-checks the turn under the session lock.
 * If an answer or completion got there first, the help is dropped (409), never attached to a
 * later turn.
 */
async function record(
  db: Database,
  userId: string,
  sessionId: string,
  input: HelpRequest,
  turn: Turn,
  shown: Shown,
): Promise<HelpResponse> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const fresh = await resolveTurn(database, userId, sessionId, input, true);
    if (fresh.pass !== turn.pass || fresh.revision.id !== turn.revision.id) {
      throw conflict("You have moved on to another question.", "stale_turn");
    }
    const event = helpEventInputSchema.parse({
      sessionId,
      questionId: turn.questionId,
      pass: turn.pass,
      action: turn.action,
      level: shown.level,
      approvedHintId: shown.approvedHintId,
      contentText: shown.approvedHintId ? undefined : shown.text,
      sourceSegmentIds: shown.citations.map((c) => c.segmentId),
      provider: shown.provider,
      model: shown.model,
      promptVersion: shown.provider ? TUTOR_PROMPT_VERSION : undefined,
      latencyMs: shown.latencyMs,
    });
    const [row] = await database
      .insert(helpEvents)
      .values({ ...event, userId, questionRevisionId: turn.revision.id })
      .returning({ id: helpEvents.id });
    return {
      help: {
        id: row!.id,
        questionId: turn.questionId,
        pass: turn.pass,
        action: turn.action,
        level: shown.level,
        text: shown.text,
        citations: shown.citations,
        sourceSupported: shown.sourceSupported,
        ...(shown.uncertainty ? { uncertainty: shown.uncertainty } : {}),
        origin: shown.origin,
        servedAs: shown.servedAs,
      },
    };
  });
}

// ---------------------------------------------------------------- entry point

export async function getHelp(
  db: Database,
  request: Request,
  sessionId: string,
  input: HelpRequest,
): Promise<HelpResponse> {
  const user = await requireUser(request);
  const turn = await resolveTurn(db, user.id, sessionId, input);
  const wanted = HELP_ACTION_LEVEL[turn.action];

  const fromHint = async (
    found: { hint: Hint; segments: CitationSegment[] },
    servedAs: Shown["servedAs"],
  ) => {
    const hintText = found.hint.text;
    const cited = turn.protectedRetry ? [] : toCitations(found.segments);
    return record(db, user.id, sessionId, input, turn, {
      level: hintLevelSchema.parse(found.hint.level),
      text: hintText,
      citations: cited,
      sourceSupported: cited.length > 0,
      origin: "approved",
      servedAs,
      approvedHintId: found.hint.id,
    });
  };

  // A reviewed hint of exactly this strength is preferred: it costs no model call. "Why was I
  // wrong" is about this student's answer, so a generic hint is not a substitute for it.
  if (turn.action !== "why_wrong") {
    const exact = await approvedHintFor(db, turn, wanted, true);
    if (exact) return fromHint(exact, "requested");
  }

  let failure: ApiError;
  try {
    const generated = await generate(db, request, turn);
    return await record(db, user.id, sessionId, input, turn, {
      level: wanted,
      text: generated.text,
      citations: generated.citations,
      sourceSupported: generated.sourceSupported,
      ...(generated.uncertainty ? { uncertainty: generated.uncertainty } : {}),
      origin: "ai_proposed",
      servedAs: "requested",
      provider: generated.provider,
      model: generated.model,
      latencyMs: generated.latencyMs,
    });
  } catch (error) {
    // A stale turn or a refusal is about the request, not the model: no fallback can fix it.
    if (error instanceof ApiError && (error.status === 409 || error.status === 403)) throw error;
    if (error instanceof ApiError) {
      failure = error;
    } else {
      console.error("tutor model call failed", error instanceof Error ? error.name : "unknown");
      failure = new AiUnavailable();
    }
  }

  const weaker = await approvedHintFor(db, turn, wanted, false);
  if (weaker) return fromHint(weaker, "fallback_hint");
  throw failure;
}
