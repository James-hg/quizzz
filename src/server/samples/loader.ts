import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { contentToRevision } from "@/lib/schemas";
import type { Database } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import {
  courses,
  questionSets,
  questionSourceLinks,
  questions,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { sha256 } from "@/server/import/sources";
import type { StorageAdapter } from "@/server/storage/types";
import type { SampleEntry } from "./directory";

export const SAMPLE_MIME = "application/vnd.quizzz.sample+yaml";

export type LoadResult = {
  courseId: string;
  questionSetId: string;
  alreadyLoaded: boolean;
  questionCount: number;
  needsReviewCount: number;
};

const sampleFilename = (language: string) => `${language}-sample-course.yaml`;

async function findExisting(db: Database, userId: string, language: string) {
  const [row] = await db
    .select({ courseId: courses.id, questionSetId: questionSets.id })
    .from(sourceDocuments)
    .innerJoin(courses, eq(courses.id, sourceDocuments.courseId))
    .innerJoin(questionSets, eq(questionSets.sourceDocumentId, sourceDocuments.id))
    .where(
      and(
        eq(courses.ownerId, userId),
        eq(sourceDocuments.mimeType, SAMPLE_MIME),
        eq(sourceDocuments.filename, sampleFilename(language)),
      ),
    );
  if (!row) return undefined;
  const count = await db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.questionSetId, row.questionSetId));
  return { ...row, questionCount: count.length };
}

/**
 * Copies a sample course into the user's account as their own, editable course.
 *
 * Idempotent per user and language: loading again returns the existing copy instead of making
 * another (it never overwrites edits, and a fixture update does not touch existing copies).
 * Delete the copy to load a fresh one. A per-user advisory lock makes concurrent loads safe.
 */
export async function loadSample(
  db: Database,
  storage: StorageAdapter,
  userId: string,
  sample: SampleEntry,
): Promise<LoadResult> {
  const existing = await findExisting(db, userId, sample.language);
  if (existing) {
    return {
      courseId: existing.courseId,
      questionSetId: existing.questionSetId,
      alreadyLoaded: true,
      questionCount: existing.questionCount,
      needsReviewCount: 0,
    };
  }

  let storageKey: string | undefined;
  try {
    return await db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`sample:${userId}:${sample.language}`}, 0))`,
      );
      const raced = await findExisting(database, userId, sample.language);
      if (raced) {
        return {
          courseId: raced.courseId,
          questionSetId: raced.questionSetId,
          alreadyLoaded: true,
          questionCount: raced.questionCount,
          needsReviewCount: 0,
        };
      }

      const { course, sections, questions: items } = sample.course;
      storageKey = await storage.put(sample.raw);

      const [createdCourse] = await database
        .insert(courses)
        .values({
          ownerId: userId,
          title: course.title,
          subject: course.subject,
          language: course.language,
        })
        .returning({ id: courses.id });
      const courseId = createdCourse!.id;

      const [document] = await database
        .insert(sourceDocuments)
        .values({
          ownerId: userId,
          courseId,
          filename: sampleFilename(sample.language),
          mimeType: SAMPLE_MIME,
          sizeBytes: sample.raw.length,
          storageKey,
          sha256: sha256(sample.raw),
          extractionStatus: "extracted",
        })
        .returning({ id: sourceDocuments.id });

      const [set] = await database
        .insert(questionSets)
        .values({
          courseId,
          ownerId: userId,
          title: course.title,
          origin: "sample",
          sourceDocumentId: document!.id,
        })
        .returning({ id: questionSets.id });

      // One heading segment and one segment per paragraph for every section.
      const segmentRows: (typeof sourceSegments.$inferInsert)[] = [];
      const sectionOrdinals = new Map<string, number[]>();
      let paragraphIndex = 0;
      for (const section of sections) {
        const ordinals: number[] = [];
        const headingPath = [section.title];
        segmentRows.push({
          sourceDocumentId: document!.id,
          ordinal: segmentRows.length,
          kind: "heading",
          text: section.title,
          anchor: { paragraphIndex: paragraphIndex++, headingPath },
        });
        ordinals.push(segmentRows.length - 1);
        for (const paragraph of section.text
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter(Boolean)) {
          segmentRows.push({
            sourceDocumentId: document!.id,
            ordinal: segmentRows.length,
            kind: "paragraph",
            text: paragraph,
            anchor: { paragraphIndex: paragraphIndex++, headingPath },
          });
          ordinals.push(segmentRows.length - 1);
        }
        sectionOrdinals.set(section.id, ordinals);
      }
      const segmentIds = new Map<number, string>();
      for (let start = 0; start < segmentRows.length; start += 500) {
        const inserted = await database
          .insert(sourceSegments)
          .values(segmentRows.slice(start, start + 500))
          .returning({ id: sourceSegments.id, ordinal: sourceSegments.ordinal });
        for (const row of inserted) segmentIds.set(row.ordinal, row.id);
      }

      let needsReviewCount = 0;
      for (const [position, item] of items.entries()) {
        const [question] = await database
          .insert(questions)
          .values({ questionSetId: set!.id, position })
          .returning({ id: questions.id });
        // Human reviewed only when the fixture says who checked it and when.
        const evidenceStatus = item.provenance
          ? ("human_reviewed" as const)
          : ("needs_review" as const);
        if (!item.provenance) needsReviewCount += 1;
        const revision = await addRevision(database, question!.id, {
          ...contentToRevision(item.content),
          origin: "sample",
          evidenceStatus,
          createdBy: userId,
        });
        const links = [
          ...new Set(item.sections.flatMap((id) => sectionOrdinals.get(id) ?? [])),
        ].map((ordinal) => ({
          questionRevisionId: revision.id,
          sourceSegmentId: segmentIds.get(ordinal)!,
          relationship: "evidence" as const,
        }));
        if (links.length > 0) await database.insert(questionSourceLinks).values(links);
      }

      return {
        courseId,
        questionSetId: set!.id,
        alreadyLoaded: false,
        questionCount: items.length,
        needsReviewCount,
      };
    });
  } catch (error) {
    if (storageKey) await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}
