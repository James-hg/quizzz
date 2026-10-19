import type { Metadata } from "next";
import Link from "next/link";
import { ImportUpload } from "@/components/ImportUpload";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getCourse } from "@/server/content/courses";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { supportedFormats } from "@/server/extract/registry";
import { ensureImportersRegistered } from "@/server/import/setup";

export const metadata: Metadata = { title: "Import · Quizzz" };
export const dynamic = "force-dynamic";

export default async function ImportPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requirePageUser();
  const courseId = await idParam(params, "courseId");
  const course = await orNotFound(getCourse(getDb(), user.id, courseId));
  // Same data as GET /api/import/formats, read directly so the picker is correct on first paint.
  ensureImportersRegistered();
  return (
    <div className="stack page-narrow">
      <p className="crumbs">
        <Link href="/">Home</Link> / <Link href={`/courses/${course.id}`}>{course.title}</Link> /
        Import
      </p>
      <h1>Import questions</h1>
      <div className="card">
        <ImportUpload
          courseId={course.id}
          formats={supportedFormats()}
          maxUploadBytes={getEnv().MAX_UPLOAD_BYTES}
        />
      </div>
    </div>
  );
}
