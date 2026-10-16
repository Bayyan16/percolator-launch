import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PnlHistoryCard, type PnlHistoryViewModel } from "@/components/dashboard/pnl-history/PnlHistoryCard";

afterEach(() => vi.unstubAllEnvs());

const demo: PnlHistoryViewModel = {
  kind: "records",
  source: "demo",
  summary: {
    today: 12.06,
    days7: 137.76,
    days30: -64.17,
    ytd: 1284.63,
    lifetime: 2917.4,
  },
  days: {
    "2026-10-05": { kind: "activity", realizedPnlUsd: -11.9 },
    "2026-10-06": { kind: "activity", realizedPnlUsd: 24.81 },
    "2026-10-07": { kind: "no-activity" },
  },
};

describe("isolated PnL History Card", () => {
  it("fails closed: missing history is unavailable, never $0 or no activity", () => {
    render(<PnlHistoryCard initialMonth="2026-10" />);
    expect(screen.getByRole("status")).toHaveTextContent(/History unavailable/);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    const unknown = within(screen.getByTestId("pnl-day-2026-10-06"));
    expect(unknown.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("October 2026")).toBeInTheDocument();
  });

  it("shows clearly labeled demo only in non-production, with explicit loss signs", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    expect(screen.getByText(/DEMO DATA — not wallet performance/)).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-day-2026-10-05")).getByText("-$11.90")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-day-2026-10-06")).getByText("+$24.81")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-day-2026-10-07")).getByText("·")).toBeInTheDocument();
    expect(screen.getByText("-$64.17")).toBeInTheDocument();
  });

  it("does not allow demo records to display in production mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    expect(screen.getByRole("status")).toHaveTextContent(/History unavailable/);
    expect(screen.queryByText("+$24.81")).not.toBeInTheDocument();
    expect(screen.queryByText(/DEMO DATA/)).not.toBeInTheDocument();
  });

  it("navigates between UTC calendar months, without fetching data", () => {
    render(<PnlHistoryCard initialMonth="2026-10" />);
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("September 2026")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(screen.getByTestId("pnl-day-2026-10-31")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DAILY" })).toBeDisabled();
  });
});
