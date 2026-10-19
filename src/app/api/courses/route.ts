import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createCourseSchema } from "@/lib/schemas";
import { createCourse, listCourses } from "@/server/content/courses";

export const GET = handleRoute(async (request: Request) => {
  const user = await requireUser(request);
  return NextResponse.json({ courses: await listCourses(getDb(), user.id) });
});

export const POST = handleRoute(async (request: Request) => {
  const user = await requireUser(request);
  const input = await readJson(request, createCourseSchema);
  return NextResponse.json(
    { course: await createCourse(getDb(), user.id, input) },
    { status: 201 },
  );
});
