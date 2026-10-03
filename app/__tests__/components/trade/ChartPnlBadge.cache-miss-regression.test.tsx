import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  pnl: 0n,

  userAccount: {
    idx: 0,
    account: {
      positionSize: -10_000_000n,
      entryPrice: 0n,
      pnl: 0n,
      owner: {
        toBase58: () =>
          "DYvC111111111111111111111111111111111111111",
      },
      adlABasis: 0n,
    },
  },

  livePriceE6: 100_000_000n,
  priceUsd: 100,
}));

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => {
    h.userAccount.account.pnl = h.pnl;
    return h.userAccount;
  },
}));

vi.mock("@/hooks/useLivePrice", () => ({
  useLivePrice: () => ({
    priceE6: h.livePriceE6,
    priceUsd: h.priceUsd,
  }),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: {
      collateralMint: null,
    },
    params: {
      initialMarginBps: 1000n,
    },
    adlFactors: null,
  }),
}));

vi.mock("@/hooks/useTokenMeta", () => ({
  useTokenMeta: () => ({
    decimals: 6,
  }),
}));

vi.mock("@/lib/mock-mode", () => ({
  isMockMode: () => false,
}));

vi.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: () => false,
  getMockUserAccount: () => null,
}));

import { getEntryPrice, saveEntryPrice } from "@/lib/entry-price";
import { ChartPnlBadge } from "@/components/trade/ChartPnlBadge";

const SLAB =
  "Eacc111111111111111111111111111111111111111";

const WALLET =
  "DYvC111111111111111111111111111111111111111";

describe("ChartPnlBadge cache-miss entry resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    h.pnl = 0n;
    h.userAccount.account.entryPrice = 0n;
  });

  it("CONTROL: exact cached entry renders the PnL badge", () => {
    saveEntryPrice(
      SLAB,
      h.userAccount.idx,
      101_000_000n,
      undefined,
      WALLET,
    );

    expect(
      getEntryPrice(
        SLAB,
        h.userAccount.idx,
        WALLET,
      ),
    ).toBe(101_000_000n);

    render(<ChartPnlBadge slabAddress={SLAB} />);

    expect(screen.getByText("PnL")).toBeInTheDocument();
  });

  it("REGRESSION: missing local entry cache keeps PnL visible when on-chain PnL determines a derived entry", () => {
    localStorage.clear();
    h.pnl = 10_000_000n;

    expect(
      getEntryPrice(
        SLAB,
        h.userAccount.idx,
        WALLET,
      ),
    ).toBe(0n);

    render(<ChartPnlBadge slabAddress={SLAB} />);

    expect(screen.getByText("PnL")).toBeInTheDocument();
  });

  it("CONTROL: genuinely unknown entry stays hidden when cache and on-chain PnL provide no entry evidence", () => {
    localStorage.clear();
    h.pnl = 0n;

    expect(
      getEntryPrice(
        SLAB,
        h.userAccount.idx,
        WALLET,
      ),
    ).toBe(0n);

    render(<ChartPnlBadge slabAddress={SLAB} />);

    expect(screen.queryByText("PnL")).not.toBeInTheDocument();
  });
});