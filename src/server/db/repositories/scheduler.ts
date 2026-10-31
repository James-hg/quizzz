import "server-only";
import { eq } from "drizzle-orm";
import { schedulerPolicyConfigSchema, type SchedulerPolicyConfig } from "@/lib/schemas";
import type { Database } from "../index";
import { schedulerPolicies } from "../schema";

/** Reads one policy version and validates its config; a malformed row fails loudly. */
export async function getSchedulerPolicy(
  db: Database,
  version: string,
): Promise<{ version: string; config: SchedulerPolicyConfig } | undefined> {
  const [row] = await db
    .select()
    .from(schedulerPolicies)
    .where(eq(schedulerPolicies.version, version));
  if (!row) return undefined;
  return { version: row.version, config: schedulerPolicyConfigSchema.parse(row.config) };
}

/** Adds a new policy version. Existing versions are never edited. */
export async function addSchedulerPolicy(
  db: Database,
  version: string,
  config: SchedulerPolicyConfig,
) {
  const valid = schedulerPolicyConfigSchema.parse(config);
  await db.insert(schedulerPolicies).values({ version, config: valid });
}
