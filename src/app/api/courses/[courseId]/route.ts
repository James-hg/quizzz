import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { updateCourseSchema } from "@/lib/schemas";
import { deleteCourse, getCourse, updateCourse } from "@/server/content/courses";

type Ctx = { params: Promise<{ courseId: string }> };

export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).courseId, "Course");
  return NextResponse.json({ course: await getCourse(getDb(), user.id, id) });
});

export const PATCH = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).courseId, "Course");
  const input = await readJson(request, updateCourseSchema);
  return NextResponse.json({ course: await updateCourse(getDb(), user.id, id, input) });
});

export const DELETE = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).courseId, "Course");
  await deleteCourse(getDb(), user.id, id);
  return new NextResponse(null, { status: 204 });
});
