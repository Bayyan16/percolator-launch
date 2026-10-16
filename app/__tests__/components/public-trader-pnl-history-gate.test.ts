import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const profile = read("app/trader/[wallet]/page.tsx");
const card = read("components/dashboard/pnl-history/PnlHistoryCard.tsx");
const flag = read("lib/portfolio-pnl-history-flag.ts");

describe("Public trader PnL history safety", () => {
  it("gates the calendar behind explicit opt-in", () => {
    expect(profile).toContain(
      'import { PnlHistoryCard }'
    );

    expect(profile).toContain(
      "isPortfolioPnlHistoryEnabled() && ("
    );

    expect(profile).toMatch(
      /\{isPortfolioPnlHistoryEnabled\(\)\s*&&\s*\(\s*<section[^>]*>\s*<PnlHistoryCard\s*\/>\s*<\/section>\s*\)\}/
    );

    expect(flag).toContain(
      'process.env.NEXT_PUBLIC_ENABLE_PORTFOLIO_PNL_HISTORY === "1"'
    );
  });

  it("defaults to unavailable historical PnL", () => {
    expect(card).toMatch(
      /data\s*=\s*\{\s*kind:\s*"unavailable"\s*\}/
    );
  });

  it("excludes demo records in production", () => {
    expect(card).toMatch(
      /data\.source === "verified"\s*\|\|\s*process\.env\.NODE_ENV !== "production"/
    );
  });

  it("does not import fabricated PnL into public profile", () => {
    expect(profile).not.toContain("local-preview-data");
    expect(profile).not.toContain("LOCAL_PNL_HISTORY_FIXTURE");
  });
});
