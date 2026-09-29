import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/useCreateMarket.ts"),
  "utf8",
);

const batchStart = SOURCE.indexOf(
  "async function attemptFreshBatchedLaunch",
);
const batchEnd = SOURCE.indexOf(
  "\nconst STEP_LABELS",
  batchStart,
);

const BATCH =
  batchStart >= 0 && batchEnd > batchStart
    ? SOURCE.slice(batchStart, batchEnd)
    : "";

function section(startMarker: string, endMarker: string): string {
  const start = BATCH.indexOf(startMarker);
  const end = BATCH.indexOf(endMarker, start + startMarker.length);

  expect(
    start,
    `missing start marker: ${startMarker}`,
  ).toBeGreaterThanOrEqual(0);

  expect(
    end,
    `missing end marker: ${endMarker}`,
  ).toBeGreaterThan(start);

  return BATCH.slice(start, end);
}

describe("fresh batched create-market state transitions", () => {
  it("has non-vacuous fresh-batch anchors", () => {
    expect(batchStart).toBeGreaterThanOrEqual(0);
    expect(batchEnd).toBeGreaterThan(batchStart);
    expect(BATCH.length).toBeGreaterThan(10_000);

    expect(BATCH).toContain(
      "const m1Sig = await broadcastTailTx(0)",
    );
    expect(BATCH).toContain(
      "const m2Sig = await broadcastTailTx(1)",
    );
    expect(BATCH).toContain(
      "const m3aSig = await broadcastTailTx(2)",
    );
  });

  it("CONTROL: keeper delegation lands before M3a funding", () => {
    const cosign = BATCH.indexOf("if (signedCosign)");
    const m3a = BATCH.indexOf(
      "const m3aSig = await broadcastTailTx(2)",
    );

    expect(cosign).toBeGreaterThanOrEqual(0);
    expect(m3a).toBeGreaterThan(cosign);
  });

  it("must not pre-sign post-delegation CAS writes with authorityEpoch 0", () => {
    const casWrites = section(
      "// M3a: DepositCollateral",
      "// BUG FIX (2026-09-25",
    );

    // Keeper UpdateAssetAuthority advances the asset authority-epoch lane.
    // Any M3a/M3b/M4 CAS-bound instruction executed AFTER that delegation
    // must not still carry the fresh pre-delegation epoch (0).
    expect(casWrites).not.toMatch(
      /authorityEpoch:\s*0n/,
    );
  });

  it("must move React retry state to Step 3 before broadcasting M3a", () => {
    const afterM2 = section(
      "const m2Sig = await broadcastTailTx(1);",
      "const m3aSig = await broadcastTailTx(2);",
    );

    // Persisted recovery already advances to lastStep=3 here.
    expect(afterM2).toContain(
      "updateInFlightStep(slabPk.toBase58(), 3)",
    );

    // The visible retry cursor must describe the same authoritative state.
    // Otherwise an M3a failure renders Retry Step 1 and replays operations
    // that already landed (including keeper delegation).
    expect(afterM2).toMatch(
      /setState\([\s\S]*?step:\s*3/,
    );
  });

  it("must not mark Step 1 complete before keeper cosign lands", () => {
    const afterM1 = section(
      "const m1Sig = await broadcastTailTx(0);",
      "const m2Sig = await broadcastTailTx(1);",
    );

    const persistedStep2 = afterM1.indexOf(
      "updateInFlightStep(slabPk.toBase58(), 2)",
    );
    const cosign = afterM1.indexOf(
      "if (signedCosign)",
    );

    expect(cosign).toBeGreaterThanOrEqual(0);
    expect(persistedStep2).toBeGreaterThan(cosign);
  });
});


describe("fresh batched CAS epoch binding controls", () => {
  it("binds keeper launches to epoch 1 and all post-cosign CAS writes use it", () => {
    expect(BATCH).toMatch(
      /const\s+postCosignAuthorityEpoch\s*=\s*cosignTx\s*\?\s*1n\s*:\s*0n\s*;/,
    );

    const consumers =
      BATCH.match(/authorityEpoch:\s*postCosignAuthorityEpoch/g) ?? [];

    // TopUpBackingBucket, TopUpInsurance and UpdateFeeSplit.
    expect(consumers).toHaveLength(3);
  });
});
