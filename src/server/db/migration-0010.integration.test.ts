import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves migration 0010 is safe on a database that already holds study data: build a scratch
 * database at 0009, add sessions and attempts, apply 0010, and check nothing was lost.
 */
const adminUrl = new URL(process.env.TEST_DATABASE_URL!);
const scratchName = `quizzz_mig_${randomBytes(4).toString("hex")}`;
const scratchUrl = new URL(adminUrl);
scratchUrl.pathname = `/${scratchName}`;
adminUrl.pathname = "/postgres";

const folder = mkdtempSync(path.join(os.tmpdir(), "quizzz-mig-"));
let admin: postgres.Sql;
let sql: postgres.Sql;

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const upTo = (tag: string) => {
  const end = journal.entries.findIndex((e) => e.tag === tag);
  return { ...journal, entries: journal.entries.slice(0, end + 1) };
};

function writeFolder(through: string) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(path.join(folder, "meta"), { recursive: true });
  for (const entry of upTo(through).entries) {
    cpSync(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify(upTo(through)));
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${scratchName}`);
  sql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end();
  await admin?.unsafe(`drop database if exists ${scratchName} with (force)`);
  await admin?.end();
  rmSync(folder, { recursive: true, force: true });
});

describe("migration 0010 on a database with study data", () => {
  it("keeps every existing row and gives old attempts an unaided level", async () => {
    // 1. The schema as it was before this migration.
    writeFolder("0009_question_rewrites");
    await migrate(drizzle(sql), { migrationsFolder: folder });
    expect(journal.entries.map((e) => e.tag)).toContain("0010_assistance_review_schema");
    const before = await sql`select to_regclass('public.help_events') as t`;
    expect(before[0]?.t).toBeNull();

    // 2. Study data written by the previous version of the app.
    const [u] =
      await sql`insert into "user" (name, email) values ('Old', 'old@example.test') returning id`;
    const [c] =
      await sql`insert into courses (owner_id, title, subject) values (${u!.id}, 'C', 'S') returning id`;
    const [set] =
      await sql`insert into question_sets (course_id, owner_id, title, origin) values (${c!.id}, ${u!.id}, 'Set', 'manual') returning id`;
    const [q] =
      await sql`insert into questions (question_set_id, position) values (${set!.id}, 0) returning id`;
    const [r] = await sql`
      insert into question_revisions (question_id, revision_number, type, prompt, options, answer_key, origin, evidence_status)
      values (${q!.id}, 1, 'mcq_single', 'Pick b', '[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb, '{"kind":"options","correctOptionIds":["b"]}'::jsonb, 'original', 'human_reviewed')
      returning id`;
    const [s] =
      await sql`insert into study_sessions (user_id, course_id, question_set_id, mode) values (${u!.id}, ${c!.id}, ${set!.id}, 'quiz') returning id, policy_version`;
    expect(s?.policy_version).toBe("v1");
    for (const [i, pass] of [1, 2].entries()) {
      await sql`
        insert into attempts (session_id, user_id, question_id, question_revision_id, response, is_correct, grading_outcome, idempotency_key, started_at, pass)
        values (${s!.id}, ${u!.id}, ${q!.id}, ${r!.id}, '{"kind":"options","selectedOptionIds":["a"]}'::jsonb, false, 'incorrect', ${`old-key-${i}-12345`}, now(), ${pass})`;
    }

    // 3. Apply the new migration on top of that data.
    writeFolder("0010_assistance_review_schema");
    await migrate(drizzle(sql), { migrationsFolder: folder });

    // Nothing was lost or rewritten.
    const rows =
      await sql`select pass, grading_outcome, idempotency_key, assistance_level::text as level from attempts order by pass`;
    expect(rows.map((x) => [x.pass, x.grading_outcome, x.idempotency_key, x.level])).toEqual([
      [1, "incorrect", "old-key-0-12345", "none"],
      [2, "incorrect", "old-key-1-12345", "none"],
    ]);
    expect((await sql`select count(*)::int as n from study_sessions`)[0]?.n).toBe(1);
    expect((await sql`select policy_version from study_sessions`)[0]?.policy_version).toBe("v1");
    expect((await sql`select count(*)::int as n from question_revisions`)[0]?.n).toBe(1);

    // The policy exists, and everything new is empty.
    const policy = await sql`select version, config from scheduler_policies`;
    expect(policy.map((p) => p.version)).toEqual(["v1"]);
    for (const table of [
      "help_events",
      "review_states",
      "approved_hints",
      "concepts",
      "concept_evidence",
    ]) {
      expect((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n).toBe(0);
    }
  });

  it("is applied exactly once: running the migrations again changes nothing", async () => {
    const [{ n: before }] =
      (await sql`select count(*)::int as n from drizzle.__drizzle_migrations`) as unknown as [
        { n: number },
      ];
    await migrate(drizzle(sql), { migrationsFolder: folder });
    const [{ n: after }] =
      (await sql`select count(*)::int as n from drizzle.__drizzle_migrations`) as unknown as [
        { n: number },
      ];
    expect(after).toBe(before);
    expect((await sql`select count(*)::int as n from scheduler_policies`)[0]?.n).toBe(1);
  });
});
