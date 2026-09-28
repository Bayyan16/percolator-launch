import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DepositWithdrawPanel } from "../../../components/earn/DepositWithdrawPanel";

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({
    connected: true,
  })),
}));

vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

const defaultProps = {
  userBalance: 0n,
  userLpBalance: 0n,
  vaultBalance: 0n,
  lpSupply: 0n,
  vaultAvailable: true,
  decimals: 6,
  collateralSymbol: "USDC",
  loading: false,
  cooldownElapsed: true,
  onDeposit: vi.fn(async () => undefined),
  onWithdraw: vi.fn(async () => undefined),
};

describe("DepositWithdrawPanel", () => {
  it("does not show a zero max deposit balance while loading", () => {
    const { rerender } = render(
      <DepositWithdrawPanel
        {...defaultProps}
        loading={true}
        userBalance={0n}
      />,
    );

    expect(screen.getByText(/Max:\s*—\s*USDC/)).toBeInTheDocument();
    expect(screen.queryByText(/Max:\s*0\s*USDC/)).not.toBeInTheDocument();

    rerender(
      <DepositWithdrawPanel
        {...defaultProps}
        loading={false}
        userBalance={16_000_000_000n}
      />,
    );

    expect(screen.getByText(/Max:\s*16000\s*USDC/)).toBeInTheDocument();
  });

  it("keeps the initial 1:1 LP preview for an available initialized-empty vault", () => {
    render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={true}
        userBalance={2_000_000_000n}
        lpSupply={0n}
        vaultBalance={0n}
      />,
    );

    fireEvent.change(screen.getByLabelText("Deposit Amount"), {
      target: { value: "1000" },
    });

    expect(screen.getByText(/≈\s*1000 LP tokens/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deposit" })).toBeEnabled();
  });

  it("fails closed and hides the LP preview when the vault becomes unavailable", () => {
    const onDeposit = vi.fn(async () => undefined);

    const { rerender } = render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={true}
        userBalance={2_000_000_000n}
        lpSupply={0n}
        vaultBalance={0n}
        onDeposit={onDeposit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Deposit Amount"), {
      target: { value: "1000" },
    });

    expect(screen.getByText(/≈\s*1000 LP tokens/)).toBeInTheDocument();

    rerender(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={false}
        userBalance={2_000_000_000n}
        lpSupply={0n}
        vaultBalance={0n}
        onDeposit={onDeposit}
      />,
    );

    expect(screen.getByLabelText("Deposit Amount")).toBeDisabled();

    expect(
      screen.getByRole("button", { name: /Set maximum amount:/ }),
    ).toBeDisabled();

    for (const pct of [25, 50, 75, 100]) {
      expect(
        screen.getByRole("button", { name: `${pct}%` }),
      ).toBeDisabled();
    }

    expect(screen.queryByText(/≈\s*1000 LP tokens/)).not.toBeInTheDocument();

    const depositButton = screen.getByRole("button", { name: "Deposit" });
    expect(depositButton).toBeDisabled();

    fireEvent.click(depositButton);
    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("keeps withdrawal actions disabled when the vault is unavailable", () => {
    const onWithdraw = vi.fn(async () => undefined);

    render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={false}
        userLpBalance={1_000_000n}
        onWithdraw={onWithdraw}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "withdraw" }),
    );

    expect(screen.getByLabelText("LP Tokens to Burn")).toBeDisabled();

    const withdrawButton = screen.getByRole("button", {
      name: "Request Withdrawal",
    });

    expect(withdrawButton).toBeDisabled();

    fireEvent.click(withdrawButton);
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it("blocks a pending-redemption claim while the vault is unavailable", () => {
    const onWithdraw = vi.fn(async () => undefined);

    render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={false}
        hasPendingRedemption={true}
        pendingRedemptionShares={1_000_000n}
        cooldownElapsed={true}
        onWithdraw={onWithdraw}
      />,
    );

    const claimButton = screen.getByRole("button", {
      name: "Claim Redemption",
    });

    expect(claimButton).toBeDisabled();

    fireEvent.click(claimButton);
    expect(onWithdraw).not.toHaveBeenCalled();
  });
});
