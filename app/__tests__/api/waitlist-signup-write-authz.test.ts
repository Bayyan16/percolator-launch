/**
 * GH#2503 — waitlist writes must be server-only.
 *
 * POST /api/waitlist/signup contains the anti-abuse and authorization
 * controls for waitlist registration. The database must therefore not expose
 * an independent anonymous write path through the Supabase publishable key.
 *
 * Security invariants:
 *
 * 1. RLS remains enabled on public.waitlist.
 * 2. No INSERT/UPDATE/DELETE/ALL policy applicable to anon may exist.
 * 3. The signup route performs the waitlist INSERT through the existing
 *    service-role client, not the publishable/anon client.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE_PATH = path.resolve(
  __dirname,
  "../../app/api/waitlist/signup/route.ts",
);

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../supabase-waitlist-schema.sql",
);

function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function createPolicyStatements(sql: string): string[] {
  return stripSqlLineComments(sql).match(/create\s+policy[\s\S]*?;/gi) ?? [];
}

/**
 * PostgreSQL CREATE POLICY defaults to:
 *
 *   FOR ALL
 *   TO PUBLIC
 *
 * when those clauses are omitted.
 *
 * PUBLIC applies to every database role, including anon, so both explicit
 * `TO anon` and policies applicable through `PUBLIC` must be treated as
 * anonymous write paths.
 */
function policyAppliesToAnon(policy: string): boolean {
  const toClause = policy.match(
    /\bto\s+([\s\S]*?)(?=\busing\b|\bwith\s+check\b|;)/i,
  );

  if (!toClause) {
    return true; // omitted TO => PUBLIC
  }

  const roles = toClause[1]
    .split(",")
    .map((role) => role.trim().toLowerCase());

  return roles.some((role) => role === "anon" || role === "public");
}

function policyAllowsWrite(policy: string): boolean {
  const command = policy.match(
    /\bfor\s+(all|select|insert|update|delete)\b/i,
  )?.[1];

  // Omitted FOR defaults to ALL.
  return !command || command.toLowerCase() !== "select";
}

function waitlistInsertSection(source: string): string {
  const start = source.indexOf("// ── Insert");

  if (start === -1) {
    throw new Error("Could not locate waitlist insert section");
  }

  return source.slice(start);
}

describe("GH#2503: waitlist writes are server-only", () => {
  it("keeps row-level security enabled on public.waitlist", () => {
    const schema = stripSqlLineComments(
      fs.readFileSync(SCHEMA_PATH, "utf8"),
    );

    expect(schema).toMatch(
      /alter\s+table\s+public\.waitlist\s+enable\s+row\s+level\s+security\s*;/i,
    );
  });

  it("has no write policy applicable to anon on public.waitlist", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");

    const anonymousWritePolicies = createPolicyStatements(schema).filter(
      (policy) =>
        /\bon\s+public\.waitlist\b/i.test(policy) &&
        policyAppliesToAnon(policy) &&
        policyAllowsWrite(policy),
    );

    expect(anonymousWritePolicies).toEqual([]);
  });

  it("uses the service-role client for the signup INSERT", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    const insertSection = waitlistInsertSection(source);

    /**
     * The writer binding immediately preceding baseRow determines which
     * Supabase credential is used by the retrying INSERT below.
     */
    const writerBinding = insertSection.match(
      /const\s+\w+\s*=\s*(getWaitlistServiceSupabase|getWaitlistSupabase)\(\);\s*const\s+baseRow/,
    );

    expect(writerBinding).not.toBeNull();
    expect(writerBinding?.[1]).toBe("getWaitlistServiceSupabase");
  });
});
