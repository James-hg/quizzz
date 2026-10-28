import "server-only";
import { and, eq } from "drizzle-orm";
import {
  draftQuestionPayloadSchema,
  type ImportWarning,
  type PatchImportItemInput,
} from "@/lib/schemas";
import type { Database } from "@/server/db";
import { importDraftItems, importDrafts } from "@/server/db/schema";
import { badRequest, conflict, notFound } from "@/server/http/errors";
import { deleteUnlinkedImages, getOwnedImage } from "@/server/images/service";
import { getStorage } from "@/server/storage";
import { getImport, getOwnedDraft } from "./drafts";

function withAnswerWarning(
  warnings: ImportWarning[],
  resolved: boolean,
  anchor?: ImportWarning["anchor"],
): ImportWarning[] {
  const rest = warnings.filter((w) => w.code !== "answer_unresolved");
  if (resolved) return rest;
  return [
    ...rest,
    {
      code: "answer_unresolved",
      message: "No correct answer was marked. Choose the answer before this can be practised.",
      anchor,
    },
  ];
}

function withImageWarning(
  warnings: ImportWarning[],
  image: { alt: string } | null | undefined,
  anchor?: ImportWarning["anchor"],
): ImportWarning[] {
  const rest = warnings.filter((w) => w.code !== "image_alt_missing");
  if (!image || image.alt.trim()) return rest;
  return [
    ...rest,
    {
      code: "image_alt_missing",
      message: "This question has an image. Describe it before accepting the question.",
      anchor,
    },
  ];
}

/** Edit, accept, or exclude one draft item. Edits are validated like editor input. */
export async function patchImportItem(
  db: Database,
  userId: string,
  draftId: string,
  itemId: string,
  input: PatchImportItemInput,
) {
  const draft = await getOwnedDraft(db, userId, draftId);
  if (draft.status === "published") throw conflict("This import is already published", "published");
  if (draft.status === "failed")
    throw conflict("This import failed and cannot be edited", "failed");

  const [item] = await db
    .select()
    .from(importDraftItems)
    .where(and(eq(importDraftItems.id, itemId), eq(importDraftItems.draftId, draftId)));
  if (!item) throw notFound("Import item not found");

  let payload = item.payload;
  let warnings = item.itemWarnings;
  let decision: typeof item.decision = item.decision;

  if (input.edit) {
    if (payload.kind !== "question") throw conflict("Only questions can be edited", "not_editable");
    if (input.edit.image) {
      // Only the image that came with the question may be described; swapping in another
      // image is done in the question editor after publishing.
      if (input.edit.image.imageId !== payload.image?.imageId) {
        throw badRequest("That image does not belong to this question.", "image_mismatch");
      }
      await getOwnedImage(db, userId, input.edit.image.imageId);
    }
    payload = draftQuestionPayloadSchema.parse({ ...payload, ...input.edit });
    warnings = withImageWarning(warnings, payload.image, warnings[0]?.anchor);
    warnings = withAnswerWarning(
      warnings,
      payload.correctOptionIds.length > 0,
      warnings[0]?.anchor,
    );
    decision = "edited";
  }
  if (input.decision === "accepted") decision = input.edit ? "edited" : "accepted";
  else if (input.decision) decision = input.decision;

  if (
    (decision === "accepted" || decision === "edited") &&
    payload.kind === "question" &&
    payload.image &&
    !payload.image.alt.trim()
  ) {
    throw badRequest("Describe the image before accepting this question.", "image_alt_required");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(importDraftItems)
      .set({ payload, itemWarnings: warnings, decision })
      .where(eq(importDraftItems.id, itemId));
    await tx
      .update(importDrafts)
      .set({ status: "reviewing", updatedAt: new Date() })
      .where(eq(importDrafts.id, draftId));
  });
  // A dropped image is deleted once nothing else (another question or draft item) needs it.
  const droppedImage = item.payload.kind === "question" ? item.payload.image : undefined;
  if (droppedImage && !(payload.kind === "question" && payload.image)) {
    await deleteUnlinkedImages(db, getStorage(), [droppedImage.imageId]);
  }
  return getImport(db, userId, draftId);
}
