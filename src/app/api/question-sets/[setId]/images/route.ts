import { NextResponse } from "next/server";
import { assertOwnsQuestionSet } from "@/server/auth/ownership";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { TooLarge } from "@/server/extract/errors";
import { conflict, handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";
import { countStagedImages, createImage, MAX_STAGED_IMAGES } from "@/server/images/service";
import { ImageTooLarge } from "@/server/images/validate";
import { readUpload } from "@/server/import/upload";
import { getStorage } from "@/server/storage";
import { imageUrl } from "@/lib/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ setId: string }> };

/**
 * Stores an image privately and returns its id. The image is staged: it is only shown once a
 * question is saved with `image: { imageId, alt }`.
 */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const setId = parseId((await params).setId, "Question set");
  const db = getDb();
  await assertOwnsQuestionSet(db, user.id, setId);

  if ((await countStagedImages(db, user.id)) >= MAX_STAGED_IMAGES) {
    throw conflict(
      "You have too many images waiting to be attached. Save or remove a question's image first.",
      "too_many_staged_images",
    );
  }

  const maxBytes = getEnv().MAX_IMAGE_BYTES;
  let upload;
  try {
    upload = await readUpload(request, maxBytes);
  } catch (error) {
    // Say the image limit in image terms (the generic upload message is in whole MB).
    if (error instanceof TooLarge) throw new ImageTooLarge(maxBytes);
    throw error;
  }
  const image = await createImage(db, getStorage(), user.id, upload.bytes, maxBytes);
  return NextResponse.json(
    {
      image: {
        id: image.id,
        url: imageUrl(image.id),
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      },
    },
    { status: 201 },
  );
});
