import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Anchor, Block, ExtractAnchor } from "@/lib/schemas";
import type { Database } from "@/server/db";
import { sourceDocuments, sourceSegments } from "@/server/db/schema";

type SegmentKind = (typeof sourceSegments.$inferInsert)["kind"];

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Extractor anchors -> the stored source anchor. Never invents Word page numbers. */
export function toSourceAnchor(anchor: ExtractAnchor): Anchor {
  switch (anchor.type) {
    case "docx_paragraph":
      return { paragraphIndex: anchor.index, headingPath: anchor.headingPath };
    case "pdf_page":
      return { page: anchor.page };
    case "slide":
      return { slide: anchor.slide };
    case "line":
      return { paragraphIndex: anchor.line };
    case "row":
      return { paragraphIndex: anchor.row };
  }
}

const SEGMENT_KINDS: Record<Block["kind"], SegmentKind> = {
  heading: "heading",
  paragraph: "paragraph",
  list_item: "list_item",
  table: "table",
  slide: "slide",
  page: "page",
};

const CHUNK = 500;

/** Stores the extracted blocks as ordered source segments. Segment ordinal = block position. */
export async function insertSegments(db: Database, sourceDocumentId: string, blocks: Block[]) {
  for (let start = 0; start < blocks.length; start += CHUNK) {
    await db.insert(sourceSegments).values(
      blocks.slice(start, start + CHUNK).map((block, offset) => ({
        sourceDocumentId,
        ordinal: start + offset,
        kind: SEGMENT_KINDS[block.kind],
        text: block.text,
        anchor: toSourceAnchor(block.anchor),
      })),
    );
  }
}

export async function setExtractionStatus(
  db: Database,
  sourceDocumentId: string,
  status: "extracted" | "failed",
) {
  await db
    .update(sourceDocuments)
    .set({ extractionStatus: status })
    .where(eq(sourceDocuments.id, sourceDocumentId));
}
