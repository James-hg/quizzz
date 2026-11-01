import "server-only";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { anchorSchema, type Anchor } from "@/lib/schemas";
import { assertOwnsCourse } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import {
  questionRevisions,
  questionSets,
  questionSourceLinks,
  questions,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { notFound } from "@/server/http/errors";

/**
 * Finding the passages of a student's own material that bear on a question, and opening one
 * passage again for a citation. Every query is filtered by owner through the source document, so
 * another user's text can never be returned. Passages are returned whole or not at all: a
 * citation must match the stored text exactly, so nothing is ever cut to fit a budget.
 */

export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 20;
export const DEFAULT_MAX_CHARS = 8_000;
export const MAX_MAX_CHARS = 20_000;
/** Words used from a query. More add cost, not precision. */
const MAX_QUERY_TERMS = 12;
/** How many extra rows are fetched so that passages too long for the budget can be skipped. */
const CANDIDATES_PER_SLOT = 3;
const MAX_LINKED = 50;

export type CitationSegment = {
  id: string;
  sourceDocumentId: string;
  filename: string;
  /** The stored passage, exactly. */
  text: string;
  kind: (typeof sourceSegments.$inferSelect)["kind"];
  anchor: Anchor;
  /** Where in the document, in words, from the stored anchor only. */
  location: string;
};

export type RetrievedSegment = CitationSegment & { origin: "linked" | "search" };

const inputSchema = z.object({
  userId: z.uuid(),
  courseId: z.uuid(),
  query: z.string().max(2_000),
  questionRevisionId: z.uuid().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  maxChars: z.number().int().min(1).max(MAX_MAX_CHARS).default(DEFAULT_MAX_CHARS),
});
export type RetrievalInput = z.input<typeof inputSchema>;

/** Reads only what the stored anchor says. Page and slide are 1-based, paragraphIndex 0-based. */
export function locationOf(anchor: Anchor): string {
  const parts: string[] = [];
  if (anchor.page !== undefined) parts.push(`page ${anchor.page}`);
  if (anchor.slide !== undefined) parts.push(`slide ${anchor.slide}`);
  if (anchor.paragraphIndex !== undefined) parts.push(`paragraph ${anchor.paragraphIndex + 1}`);
  if (anchor.headingPath?.length) parts.push(`under "${anchor.headingPath.join(" > ")}"`);
  return parts.join(", ");
}

const columns = {
  id: sourceSegments.id,
  sourceDocumentId: sourceSegments.sourceDocumentId,
  filename: sourceDocuments.filename,
  text: sourceSegments.text,
  kind: sourceSegments.kind,
  anchor: sourceSegments.anchor,
};
type Row = {
  id: string;
  sourceDocumentId: string;
  filename: string;
  text: string;
  kind: CitationSegment["kind"];
  anchor: unknown;
};

/** Null when the stored anchor is not usable: a passage that cannot be located cannot be cited. */
function toCitation(row: Row): CitationSegment | null {
  const anchor = anchorSchema.safeParse(row.anchor);
  if (!anchor.success) return null;
  return { ...row, anchor: anchor.data, location: locationOf(anchor.data) };
}

/** One passage, if it is in one of the user's documents. Missing and foreign look the same. */
export async function getOwnedSegment(
  db: Database,
  userId: string,
  segmentId: string,
): Promise<CitationSegment> {
  const [row] = await db
    .select(columns)
    .from(sourceSegments)
    .innerJoin(sourceDocuments, eq(sourceSegments.sourceDocumentId, sourceDocuments.id))
    .where(and(eq(sourceSegments.id, segmentId), eq(sourceDocuments.ownerId, userId)));
  const citation = row ? toCitation(row) : null;
  if (!citation) throw notFound("Passage not found");
  return citation;
}

/** Distinct words of a query, as plain letters and digits only. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_QUERY_TERMS);
}

/** Words OR-ed together: a question is not a keyword list, so any matching word counts. */
function anyWord(terms: string[]): SQL {
  return sql.join(
    terms.map((t) => sql`plainto_tsquery('simple'::regconfig, ${t})`),
    sql` || `,
  );
}

/**
 * Passages for a question, within bounds: the ones linked to the question's revision first (in
 * document order), then ranked full-text hits from the same course, without repeats. At most
 * `limit` passages and `maxChars` characters of passage text; a passage that does not fit is
 * skipped, never shortened.
 */
export async function findRelevantSegments(
  db: Database,
  rawInput: RetrievalInput,
): Promise<RetrievedSegment[]> {
  const input = inputSchema.parse(rawInput);
  await assertOwnsCourse(db, input.userId, input.courseId);

  if (input.questionRevisionId) {
    // The question must be this user's and belong to this course.
    const [owned] = await db
      .select({ id: questionRevisions.id })
      .from(questionRevisions)
      .innerJoin(questions, eq(questionRevisions.questionId, questions.id))
      .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
      .where(
        and(
          eq(questionRevisions.id, input.questionRevisionId),
          eq(questionSets.ownerId, input.userId),
          eq(questionSets.courseId, input.courseId),
        ),
      );
    if (!owned) throw notFound("Question not found");
  }

  const mine = and(
    eq(sourceDocuments.ownerId, input.userId),
    eq(sourceDocuments.courseId, input.courseId),
  );
  const inReadingOrder = [
    asc(sourceDocuments.createdAt),
    asc(sourceDocuments.id),
    asc(sourceSegments.ordinal),
  ];

  const linked: Row[] = input.questionRevisionId
    ? await db
        .select(columns)
        .from(questionSourceLinks)
        .innerJoin(sourceSegments, eq(questionSourceLinks.sourceSegmentId, sourceSegments.id))
        .innerJoin(sourceDocuments, eq(sourceSegments.sourceDocumentId, sourceDocuments.id))
        .where(and(eq(questionSourceLinks.questionRevisionId, input.questionRevisionId), mine))
        // A passage linked as both origin and evidence appears twice; `take` keeps the first.
        .orderBy(...inReadingOrder)
        .limit(MAX_LINKED)
    : [];

  const terms = queryTerms(input.query);
  let hits: Row[] = [];
  if (terms.length > 0) {
    const tsquery = anyWord(terms);
    hits = await db
      .select(columns)
      .from(sourceSegments)
      .innerJoin(sourceDocuments, eq(sourceSegments.sourceDocumentId, sourceDocuments.id))
      .where(and(mine, sql`${sourceSegments.searchVector} @@ (${tsquery})`))
      .orderBy(
        desc(sql`ts_rank_cd(${sourceSegments.searchVector}, ${tsquery})`),
        ...inReadingOrder,
        asc(sourceSegments.id),
      )
      .limit(input.limit * CANDIDATES_PER_SLOT);
  }

  const out: RetrievedSegment[] = [];
  const seen = new Set<string>();
  let used = 0;
  const take = (rows: Row[], origin: RetrievedSegment["origin"]) => {
    for (const row of rows) {
      if (out.length >= input.limit) return;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (used + row.text.length > input.maxChars) continue;
      const citation = toCitation(row);
      if (!citation) continue;
      used += row.text.length;
      out.push({ ...citation, origin });
    }
  };
  take(linked, "linked");
  take(hits, "search");
  return out;
}
