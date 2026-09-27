import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => {
  const getSlot = vi.fn();

  return {
    getSlot,
    connection: {
      getSlot,
    },
  };
});

let slabState: Record<string, unknown> = {};

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    // Production uses a stable shared Connection object.
    connection: mocks.connection,
  }),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => slabState,
}));

import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";

const CURRENT_SLOT = 400_000_000n;

const NON_ZERO_AUTHORITY = new PublicKey(
  "Sysvar1111111111111111111111111111111111112",
);

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getSlot.mockResolvedValue(Number(CURRENT_SLOT));

  slabState = {
    config: {
      oracleAuthority: NON_ZERO_AUTHORITY,
      indexFeedId: PublicKey.default,
      authorityTimestamp: 0n,
      authorityPriceE6: 150_000_000n,
      lastEffectivePriceE6: 150_000_000n,
      collateralMint: new PublicKey(
        "So11111111111111111111111111111111111111112",
      ),
    },

    engine: null,

    wrapperConfigV17: {
      oracleMode: 3,
      markEwmaE6: 150_000_000n,
      markEwmaLastSlot: CURRENT_SLOT - 10n,
      lastGoodOracleSlot: CURRENT_SLOT - 10n,
    },
  };
});

describe("shared cluster-slot ticker", () => {
  it("NEGATIVE CONTROL: oracle + engine freshness share one getSlot poller", async () => {
    const { result, unmount } = renderHook(() => {
      const oracle = useOracleFreshness();
      const engine = useEngineFreshness();

      return { oracle, engine };
    });

    await waitFor(() => {
      expect(result.current.engine.currentSlot).toBe(CURRENT_SLOT);
    });

    expect(result.current.oracle.level).toBe("fresh");

    // Both hooks consume the same cluster slot, but a stable production
    // connection must start only one shared RPC poller.
    expect(mocks.getSlot).toHaveBeenCalledTimes(1);

    unmount();
  });
});
