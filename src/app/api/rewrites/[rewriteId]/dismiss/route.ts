import { requireUser } from "@/server/auth/session";
import { dismissRewrite } from "@/server/content/rewrites";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ rewriteId: string }> };

export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).rewriteId, "Proposal");
  await dismissRewrite(getDb(), user.id, id);
  return new Response(null, { status: 204 });
});
