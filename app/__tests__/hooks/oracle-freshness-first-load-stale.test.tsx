import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

let slabState: Record<string, unknown> = {};

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => slabState,
}));

const mocks = vi.hoisted(() => ({
  getSlot: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: {
      getSlot: mocks.getSlot,
    },
  }),
}));

import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { isOracleStaleBlocking } from "@/lib/oracle-stale-gate";
import {
  isKeeperFeedDead,
  KEEPER_PRICE_STALE_THRESHOLD_SLOTS,
} from "@/components/my-markets/attentionLogic";

const ORACLE_MODE_KEEPER = 3;
const ORACLE_MODE_ADMIN = 0;

const CURRENT_SLOT = 400_000_000n;
const SLOTS_PER_HOUR = 9_000n;
const DEAD_PUSH_SLOT = CURRENT_SLOT - SLOTS_PER_HOUR;
const HEALTHY_PUSH_SLOT = CURRENT_SLOT - 10n;

const NON_ZERO_AUTHORITY = new PublicKey(
  "Sysvar1111111111111111111111111111111111112",
);

const NON_ZERO_FEED = new PublicKey(
  "Sysvar1111111111111111111111111111111111113",
);

function keeperMarket(
  pushSlot: bigint,
  markEwmaE6 = 150_000_000n,
) {
  return {
    config: {
      oracleAuthority: NON_ZERO_AUTHORITY,
      indexFeedId: PublicKey.default,
      authorityTimestamp: 0n,
      authorityPriceE6: 150_000_000n,
      lastEffectivePriceE6: markEwmaE6,
      collateralMint: new PublicKey(
        "So11111111111111111111111111111111111111112",
      ),
    },

    // Mirrors SlabProvider's actual v17 behaviour.
    engine: null,

    wrapperConfigV17: {
      oracleMode: ORACLE_MODE_KEEPER,
      markEwmaE6,
      markEwmaLastSlot: pushSlot,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSlot.mockResolvedValue(Number(CURRENT_SLOT));
  slabState = keeperMarket(DEAD_PUSH_SLOT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GH#2583: v17 oracle freshness derives age from push slot", () => {
  it("CHARACTERIZATION: first render currently reports an hour-dead feed as fresh", async () => {
    const { result } = renderHook(() => useOracleFreshness());

    expect(result.current.mode).toBe("keeper");
    expect(result.current.ready).toBe(true);
    expect(result.current.level).toBe("fresh");
    expect(result.current.elapsedSecs).toBe(0);

    await act(async () => {
      await Promise.resolve();
    });
  });

  it("INVARIANT: an hour-dead keeper feed must become stale and block trading", async () => {
    const { result } = renderHook(() => useOracleFreshness());

    await waitFor(() => {
      expect(result.current.level).toBe("stale");
    });

    expect(
      isOracleStaleBlocking(
        result.current.level,
        result.current.mode,
        result.current.ready,
      ),
    ).toBe(true);
  });

  it("INVARIANT: elapsedSecs reports the true slot-derived age", async () => {
    const { result } = renderHook(() =>
      useOracleFreshness({ trackSeconds: true }),
    );

    await waitFor(() => {
      expect(result.current.elapsedSecs).toBeGreaterThan(3_000);
    });

    expect(result.current.elapsedSecs).toBeLessThan(4_200);
  });

  it("NEGATIVE CONTROL: My Markets classifies the same feed as dead", () => {
    const market = keeperMarket(DEAD_PUSH_SLOT);

    const dead = isKeeperFeedDead(
      {
        config: market.config,
        configV17: market.wrapperConfigV17,
      } as unknown as Parameters<typeof isKeeperFeedDead>[0],
      CURRENT_SLOT,
    );

    expect(SLOTS_PER_HOUR).toBeGreaterThan(
      BigInt(KEEPER_PRICE_STALE_THRESHOLD_SLOTS),
    );

    expect(dead).toBe(true);
  });

  it("NEGATIVE CONTROL: healthy keeper push remains fresh and unblocked", async () => {
    slabState = keeperMarket(HEALTHY_PUSH_SLOT);

    const { result } = renderHook(() => useOracleFreshness());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.level).toBe("fresh");

    expect(
      isOracleStaleBlocking(
        result.current.level,
        result.current.mode,
        result.current.ready,
      ),
    ).toBe(false);
  });

  it("INVARIANT: remount cannot reset an old feed back to zero age", async () => {
    const first = renderHook(() =>
      useOracleFreshness({ trackSeconds: true }),
    );

    await waitFor(() => {
      expect(first.result.current.ready).toBe(true);
    });

    await waitFor(
      () => {
        expect(first.result.current.elapsedSecs).toBeGreaterThan(0);
      },
      {
        timeout: 2_500,
      },
    );

    first.unmount();

    const second = renderHook(() =>
      useOracleFreshness({ trackSeconds: true }),
    );

    await waitFor(() => {
      expect(second.result.current.ready).toBe(true);
    });

    await waitFor(() => {
      expect(second.result.current.elapsedSecs).toBeGreaterThan(3_000);
    });

    expect(second.result.current.level).toBe("stale");

    expect(
      isOracleStaleBlocking(
        second.result.current.level,
        second.result.current.mode,
        second.result.current.ready,
      ),
    ).toBe(true);
  });

  it("NEGATIVE CONTROL: ~45 second old push is aging and does not block", async () => {
    slabState = keeperMarket(CURRENT_SLOT - 113n);

    const { result } = renderHook(() =>
      useOracleFreshness({ trackSeconds: true }),
    );

    await waitFor(() => {
      expect(result.current.elapsedSecs).toBeGreaterThan(30);
    });

    expect(result.current.level).toBe("aging");

    expect(
      isOracleStaleBlocking(
        result.current.level,
        result.current.mode,
        result.current.ready,
      ),
    ).toBe(false);
  });

  it("NEGATIVE CONTROL: ~90 second old push is stale and blocks", async () => {
    slabState = keeperMarket(CURRENT_SLOT - 225n);

    const { result } = renderHook(() => useOracleFreshness());

    await waitFor(() => {
      expect(result.current.level).toBe("stale");
    });

    expect(
      isOracleStaleBlocking(
        result.current.level,
        result.current.mode,
        result.current.ready,
      ),
    ).toBe(true);
  });

  it("NEGATIVE CONTROL: never-cranked market remains unavailable", async () => {
    slabState = keeperMarket(0n, 0n);

    const { result } = renderHook(() => useOracleFreshness());

    await waitFor(() => {
      expect(result.current.mode).toBe("keeper");
    });

    expect(result.current.level).toBe("unavailable");
    expect(result.current.ready).toBe(false);
  });

  it("NEGATIVE CONTROL: admin timestamp still derives real staleness", async () => {
    const twoHoursAgo =
      BigInt(Math.floor(Date.now() / 1000)) - 7_200n;

    slabState = {
      config: {
        oracleAuthority: NON_ZERO_AUTHORITY,
        indexFeedId: NON_ZERO_FEED,
        authorityTimestamp: twoHoursAgo,
        authorityPriceE6: 150_000_000n,
        lastEffectivePriceE6: 150_000_000n,
        collateralMint: new PublicKey(
          "So11111111111111111111111111111111111111112",
        ),
      },

      engine: null,

      wrapperConfigV17: {
        oracleMode: ORACLE_MODE_ADMIN,
        markEwmaE6: 0n,
        markEwmaLastSlot: 0n,
      },
    };

    const { result } = renderHook(() => useOracleFreshness());

    await waitFor(() => {
      expect(result.current.mode).toBe("admin");
    });

    expect(result.current.level).toBe("stale");

    expect(
      isOracleStaleBlocking(
        result.current.level,
        result.current.mode,
        result.current.ready,
      ),
    ).toBe(true);
  });

  it("CONTROL: true age is derivable from clusterSlot - markEwmaLastSlot", () => {
    const elapsedSecs =
      Number(CURRENT_SLOT - DEAD_PUSH_SLOT) * 0.4;

    expect(elapsedSecs).toBeGreaterThan(3_000);
    expect(elapsedSecs).toBeLessThan(4_200);
  });
});