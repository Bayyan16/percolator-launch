import {
  act,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
    // Production also exposes a stable shared Connection object.
    connection: mocks.connection,
  }),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => slabState,
}));

import { useClusterSlot } from "@/hooks/useClusterSlot";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { isOracleStaleBlocking } from "@/lib/oracle-stale-gate";

const CURRENT_SLOT = 400_000_000n;
const LATE_GENERATION_SLOT = CURRENT_SLOT + 500n;

const NON_ZERO_AUTHORITY = new PublicKey(
  "Sysvar1111111111111111111111111111111111112",
);

function keeperMarket(pushSlot: bigint) {
  return {
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
      markEwmaLastSlot: pushSlot,
      lastGoodOracleSlot: pushSlot,
    },
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.getSlot.mockReset();
  slabState = keeperMarket(CURRENT_SLOT - 10n);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodeRabbit follow-up regressions for GH#2583", () => {
  it("ignores a late getSlot completion from a previous subscriber generation", async () => {
    let resolveOldRequest!: (slot: number) => void;
    let resolveNewRequest!: (slot: number) => void;

    mocks.getSlot
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveOldRequest = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveNewRequest = resolve;
          }),
      );

    const first = renderHook(() => useClusterSlot());

    expect(mocks.getSlot).toHaveBeenCalledTimes(1);

    // Tear down generation A while its RPC request is still in flight.
    first.unmount();

    // Generation B starts a new request.
    const second = renderHook(() => useClusterSlot());

    expect(mocks.getSlot).toHaveBeenCalledTimes(2);

    // New generation resolves first with the correct current slot.
    await act(async () => {
      resolveNewRequest(Number(CURRENT_SLOT));
      await Promise.resolve();
    });

    expect(second.result.current).toBe(CURRENT_SLOT);

    // The old generation now completes late. It must NOT overwrite B.
    await act(async () => {
      resolveOldRequest(Number(LATE_GENERATION_SLOT));
      await Promise.resolve();
    });

    expect(second.result.current).toBe(CURRENT_SLOT);

    second.unmount();
  });

  it("does not rebase a cached cluster-slot observation when slab state rerenders later", async () => {
    const BASE_TIME_MS = 2_000_000_000_000;

    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME_MS);

    mocks.getSlot.mockResolvedValue(Number(CURRENT_SLOT));

    // 113 slots * 400ms ~= 45.2 seconds old.
    const pushSlot = CURRENT_SLOT - 113n;
    slabState = keeperMarket(pushSlot);

    const {
      result,
      rerender,
      unmount,
    } = renderHook(() =>
      useOracleFreshness({ trackSeconds: true }),
    );

    // Resolve getSlot(), publish the observation, derive lastUpdateMs,
    // and allow React effects/state updates to settle.
    await flushMicrotasks();
    await flushMicrotasks();

    expect(result.current.level).toBe("aging");
    expect(result.current.elapsedSecs).toBeGreaterThan(30);
    expect(result.current.elapsedSecs).toBeLessThanOrEqual(60);

    // Advance wall time by 20 seconds WITHOUT producing a newer cluster-slot
    // observation. The original ~45s-old keeper push is now ~65s old.
    vi.setSystemTime(BASE_TIME_MS + 20_000);

    // Simulate an unrelated SlabProvider state publication with the same
    // markEwmaLastSlot. This must not rebase the estimated push timestamp.
    slabState = keeperMarket(pushSlot);
    rerender();

    await flushMicrotasks();

    // Drive the hook's shared 1 Hz freshness ticker deterministically.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(result.current.level).toBe("stale");

    expect(
      isOracleStaleBlocking(
        result.current.level,
        result.current.mode,
        result.current.ready,
      ),
    ).toBe(true);

    unmount();
  });
});
