// @vitest-environment node
/** UX WP-9 AC1 (audit §3.10): the creator-stake state, the program's 97 rule, reason precedence. */
import { describe, expect, it } from "vitest";
import { clampStakeWithdraw, creatorStakeState, stakeReasonFromRefusal } from "@/lib/limits/creator-stake";
import { juniorWithdrawableAtoms } from "@/lib/limits/vault-tranche";
import { SimulationRefusal } from "@/lib/tx";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { isJuniorWithdrawRefusal } from "@/hooks/useJuniorTranche";

const C = 1_000_000_000n;
const base = { vaultValue: C + 300_000_000n, seniorClaimEff: C, backingCover: C, floorBps: 2_000, lpFlat: true, drawOutstandingAtoms: 0n, impaired: false };

describe("creatorStakeState", () => {
  it("withdrawable = junior above the floor (the same rule as juniorWithdrawableAtoms), no reason", () => {
    const s = creatorStakeState(base);
    expect(s).toMatchObject({ stakeValue: 300_000_000n, protects: C, mustKeep: 200_000_000n, floorPct: "20%", withdrawable: 100_000_000n, reason: null });
    expect(s.withdrawable).toBe(juniorWithdrawableAtoms(base.vaultValue, C, C, 2_000));
  });
  it("reason precedence: draw pending > LP open > backing short > at floor; withdrawable 0 with each", () => {
    expect(creatorStakeState({ ...base, drawOutstandingAtoms: 1n, lpFlat: false, backingCover: 0n })).toMatchObject({ reason: "draw-pending", withdrawable: 0n });
    expect(creatorStakeState({ ...base, lpFlat: false, backingCover: 0n })).toMatchObject({ reason: "lp-open", withdrawable: 0n });
    expect(creatorStakeState({ ...base, backingCover: C - 1n })).toMatchObject({ reason: "backing-short", withdrawable: 0n });
    expect(creatorStakeState({ ...base, vaultValue: C + 150_000_000n })).toMatchObject({ reason: "at-floor", withdrawable: 0n });
  });
  it("unknown value: no withdrawable, no reason; 12.5% floors keep a decimal", () => {
    expect(creatorStakeState({ ...base, vaultValue: null })).toMatchObject({ stakeValue: null, withdrawable: null, reason: null });
    expect(creatorStakeState({ ...base, floorBps: 1_250 }).floorPct).toBe("12.5%");
  });
  it("a 75 refusal maps to the state's reason, else a NEUTRAL line (GH#3680)", () => {
    // Unchanged: a reason the state explains always wins.
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, drawOutstandingAtoms: 3n }))).toBe("draw-pending");
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, lpFlat: false, backingCover: 0n }))).toBe("lp-open");
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, backingCover: C - 1n }))).toBe("backing-short");
    // A real at-floor state still reads as the floor.
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, vaultValue: C + 150_000_000n }))).toBe("at-floor");

    // CHANGED (GH#3680). `base` has `reason: null` and `withdrawable: 100_000_000n` -- the state
    // does NOT explain this refusal, and it computed a POSITIVE withdrawable above the floor.
    // The old fallback answered "at-floor" ("This is the minimum you must keep while Earn
    // deposits are in the vault"), which this very fixture disproves. Tag 97 has more refusal
    // causes than this module models -- RC2 adds the AUD-S1-15 open-interest lock, which fires
    // when the vault LP is FLAT, i.e. exactly when `lp-open` is not selected -- so the fallback
    // must not name a cause it cannot know.
    const unexplained = creatorStakeState(base);
    expect(unexplained).toMatchObject({ reason: null, withdrawable: 100_000_000n });
    expect(stakeReasonFromRefusal(unexplained)).toBe("locked");
  });
  it("clamp", () => {
    expect(clampStakeWithdraw(5n, 3n)).toBe(3n);
    expect(clampStakeWithdraw(2n, 3n)).toBe(2n);
    expect(clampStakeWithdraw(2n, null)).toBe(0n);
    expect(clampStakeWithdraw(-1n, 3n)).toBe(0n);
  });
  it("isJuniorWithdrawRefusal: only a pre-sign 75 refusal", () => {
    expect(isJuniorWithdrawRefusal(new SimulationRefusal({ InstructionError: [1, { Custom: WRAPPER_ERR.VaultLpJuniorWithdrawRefused }] }))).toBe(true);
    expect(isJuniorWithdrawRefusal(new SimulationRefusal({ InstructionError: [1, { Custom: 21 }] }))).toBe(false);
    expect(isJuniorWithdrawRefusal(new Error("custom program error: 0x4b"))).toBe(false);
  });
});
