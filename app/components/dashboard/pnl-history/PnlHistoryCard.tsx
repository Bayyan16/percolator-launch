"use client";

import { useState } from "react";

/** Presentation contract only. A future verified history adapter supplies records. */
export type PnlHistoryDay =
  | { kind: "activity"; realizedPnlUsd: number }
  | { kind: "no-activity" };

type SummaryKey = "today" | "days7" | "days30" | "ytd" | "lifetime";
export type PnlHistoryViewModel =
  | { kind: "unavailable" }
  | {
      kind: "records";
      source: "verified" | "demo";
      summary: Readonly<Record<SummaryKey, number | null>>;
      /** ISO UTC day keys. Missing day = unknown, never inferred as no activity. */
      days: Readonly<Record<string, PnlHistoryDay>>;
    };

const SUMMARY: { key: SummaryKey; label: string }[] = [
  { key: "today", label: "Today PnL" },
  { key: "days7", label: "7D PnL" },
  { key: "days30", label: "30D PnL" },
  { key: "ytd", label: "YTD PnL" },
  { key: "lifetime", label: "Lifetime PnL" },
];
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function usd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pnlColor(value: number): string {
  if (value > 0) return "text-[var(--long)]";
  if (value < 0) return "text-[var(--short)]";
  return "text-[var(--text-secondary)]";
}

function firstMonth(initialMonth?: string): Date {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(initialMonth ?? "");
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Isolated calendar UI: no wallet hooks, fetch, RPC, mock-mode dependency,
 * price calculations, or writes to existing Portfolio state.
 * Demo records are ignored in production builds even if passed by a caller.
 */
export function PnlHistoryCard({
  data = { kind: "unavailable" },
  initialMonth,
}: {
  data?: PnlHistoryViewModel;
  /** YYYY-MM, for deterministic previews/tests; displayed dates are UTC. */
  initialMonth?: string;
}) {
  const [month, setMonth] = useState(() => firstMonth(initialMonth));
  const records =
    data.kind === "records" &&
    (data.source === "verified" || process.env.NODE_ENV !== "production")
      ? data
      : null;
  const demo = records?.source === "demo";

  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const startOffset = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cellCount = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const monthLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "long", year: "numeric",
  }).format(month);

  function moveMonth(delta: number) {
    setMonth((previous) =>
      new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + delta, 1)),
    );
  }

  return (
    <section aria-label="PnL History" className="min-w-0 border border-[var(--border)] bg-[var(--panel-bg)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">PnL History</h2>
          <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
            {demo ? "DEMO DATA — not wallet performance" : "Historical realized PnL · UTC"}
          </p>
        </div>
        <div className="flex max-w-full gap-1 text-[9px]" aria-label="History ranges">
          {(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).map((range) => (
            <button
              key={range}
              type="button"
              disabled={range !== "MONTHLY"}
              aria-current={range === "MONTHLY" ? "true" : undefined}
              title={range !== "MONTHLY" ? "Not implemented in this phase" : undefined}
              className={`rounded-sm border border-[var(--border)] px-2 py-1.5 ${range === "MONTHLY" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "cursor-not-allowed text-[var(--text-secondary)] opacity-50"}`}
            >
              {range}
            </button>
          ))}
        </div>
      </header>

      {demo && (
        <p role="note" className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--warning)]">
          Preview only. Values are fabricated and must not be used for trading decisions.
        </p>
      )}
      {!records && (
        <p role="status" className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-secondary)]">
          History unavailable — no verified historical PnL source connected.
        </p>
      )}

      <div className="grid grid-cols-2 gap-px border-b border-[var(--border)] bg-[var(--border)] sm:grid-cols-5">
        {SUMMARY.map(({ key, label }) => {
          const value = records?.summary[key] ?? null;
          return (
            <div key={key} className={`min-w-0 bg-[var(--panel-bg)] p-3 ${key === "lifetime" ? "col-span-2 sm:col-span-1" : ""}`}>
              <div className="text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">{label}</div>
              <div className={`mt-1 truncate text-xs font-bold tabular-nums sm:text-sm ${value == null ? "text-[var(--text-secondary)]" : pnlColor(value)}`}>
                {usd(value)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)} className="border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)]">‹</button>
          <h3 className="text-xs font-semibold uppercase text-[var(--text)]">{monthLabel}</h3>
          <button type="button" aria-label="Next month" onClick={() => moveMonth(1)} className="border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)]">›</button>
        </div>
        <span className="text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">Monthly · UTC</span>
      </div>
      <div className="grid grid-cols-7 border-b border-[var(--border)]">
        {WEEKDAYS.map((day) => (
          <div key={day} className="min-w-0 py-2 text-center text-[9px] text-[var(--text-secondary)]">{day}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-[var(--border)]" aria-label={`${monthLabel} calendar`}>
        {Array.from({ length: cellCount }, (_, index) => {
          const date = new Date(Date.UTC(year, monthIndex, 1 + index - startOffset));
          const inMonth = date.getUTCMonth() === monthIndex && date.getUTCFullYear() === year;
          const key = date.toISOString().slice(0, 10);
          const day = inMonth ? records?.days[key] : undefined;
          const value = day?.kind === "activity" ? day.realizedPnlUsd : null;
          const background = value != null && value > 0 ? "bg-[var(--long)]/10" : value != null && value < 0 ? "bg-[var(--short)]/10" : "bg-[var(--panel-bg)]";
          return (
            <div key={key} data-testid={`pnl-day-${key}`} className={`min-w-0 p-1.5 sm:p-2 ${background} ${inMonth ? "" : "opacity-35"}`}>
              <div className="text-[9px] text-[var(--text-secondary)]">{date.getUTCDate()}</div>
              <div className={`mt-2 truncate text-[9px] font-semibold tabular-nums ${value == null ? "text-[var(--text-secondary)]" : pnlColor(value)}`}>
                {!inMonth || !day ? "—" : day.kind === "no-activity" ? "·" : usd(value)}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="px-3 py-2 text-[9px] text-[var(--text-secondary)]">
        Green: profit · Red: loss · Dot: confirmed no activity · —: unavailable
      </footer>
    </section>
  );
}
