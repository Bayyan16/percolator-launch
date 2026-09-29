"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
  MINT_SIZE,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import {
  encodeInitMarket,
  type InitMarketV17Args,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodePermissionlessCrank,
  encodeInitMatcherCtx,
  encodeSetMatcherConfig,
  encodeInitUser,
  encodeSetNftProgramId,
  encodeCreateLpVaultV17,
  encodeStakeInitPool,
  encodeUpdateFeeSplit,
  encodeStakeBindInsuranceAuthority,
  bindInsuranceAuthorityAccounts,
  ACCOUNTS_UPDATE_FEE_SPLIT,
  validateFeeSplit,
  encodeTopUpBackingBucket,
  MAX_BACKING_BUCKET_EXPIRY_SLOT,
  detectDexType,
  parseDexPool,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  ACCOUNTS_SET_MATCHER_CONFIG,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_CREATE_LP_VAULT,
  ACCOUNTS_TOP_UP_BACKING_BUCKET,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  deriveMatcherDelegate,
  deriveNftRegistry,
  deriveLpVaultRegistry,
  deriveInsuranceLpMint,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveLpBackingLedger,
  initPoolAccounts,
  parseHeader,
  isV17Account,
  v17MarketAccountLen,
  V17_PORTFOLIO_ACCOUNT_LEN,
  MATCHER_CONTEXT_LEN,
  // W2/W3 fix (2026-07-08): parsePortfolioV17 reads the LP portfolio's on-chain
  // `capital` so Step 3 can detect an already-landed deposit/top-up before
  // resending it — see the Step 3 block below.
  parsePortfolioV17,
  parseMarketGroupV17OI,
} from "@percolatorct/sdk";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { toE6 } from "@/lib/format";
import { buildKeeperRegisterProofMessage } from "@/lib/keeper-register-proof";
import { deriveMarketParams, MIN_LEVERAGE_X, backingSeedPerDomain, leverageFromMarginBps } from "@/lib/market-params";
// GH#2592: the step-4 predicate and /api/devnet-pre-fund's funding target must be
// the SAME number. They were two hand-copies, and the route's was understated by
// both backing seeds, so it answered "sufficient" to the very request that said
// the wallet was short.
import { fullMarketRequirement } from "@/lib/prefund-requirement";
import { defaultCrankObservations, readPortfolioIdentity, readAssetMarketId, readAssetControlSeqs } from "@/lib/v18-wire";
// v17: SetOracleAuthority (tag 17), PushOraclePrice (tag 16), SetOraclePriceCap (tag 16),
// and UpdateConfig (tag 14) do not exist in v17. All oracle + risk params are embedded
// in InitMarket (extended tail). The sdk-compat stubs throw at runtime if called.
// We guard all callsites with isAdminOracle && !isV17Slab before using these.
import {
  sendTx,
  prewarmTxLanding,
  buildBatchTx,
  signAllCompat,
  broadcastSignedTx,
  getFreshBlockhash,
  getPriorityFee,
  isBlockhashExpiredError,
  isConfirmationTimeoutError,
  checkSignatureLanded,
  TxCancelledError,
  isTxCancelledError,
} from "@/lib/tx";
import { getConfig, getNetwork } from "@/lib/config";
import { resolveMarketOracleMode } from "@/lib/resolveMarketOracleMode";
import { normalizeDexType } from "@/lib/dex-type";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import {
  inspectV17MatcherContext,
  isEmptyV17PortfolioMatcherConfig,
  readV17PortfolioMatcherConfig,
} from "@/lib/v17-matcher-state";
import {
  saveInFlightMarket,
  updateInFlightStep,
  clearInFlightMarket,
  loadLastInFlightMarket,
} from "@/lib/inFlightMarket";
import {
  type MarketRegistrationPayload,
} from "@/lib/market-registration-auth";
// v17: max assets per portfolio (= the market's asset-slot capacity); program cap = 14.
// The slab MUST be sized to exactly match this capacity or InitMarket reverts (dynamic-len validation).
export const V17_MAX_PORTFOLIO_ASSETS = 14;
// BUG 1 fix (2026-07-06): exported so callers (CreateMarketWizard, CostEstimate) size the
// slab + rent estimate against the actual v17 requirement instead of the stale v12.19
// tier.dataSize concept (96784/376432/1495024 bytes), which never equals this value for any
// tier and made every InitMarket revert with InvalidSlabLen while over-charging ~0.67 SOL rent.
export const DEFAULT_SLAB_SIZE = v17MarketAccountLen(V17_MAX_PORTFOLIO_ASSETS); // 26_364 bytes (cap-14)
const ALL_ZEROS_FEED = "0".repeat(64);

/**
 * Order the stake-tail instructions so the fee-split → stake-pool sequence is
 * always correct, in BOTH the batched (M4) and sequential (Step 5) create paths:
 *
 *   [...preInitPool] → [UpdateFeeSplit?] → StakeInitPool → BindInsuranceAuthority
 *
 * WHY the order is load-bearing:
 *  - UpdateFeeSplit (wrapper tag 86) is gated on cfg.marketauth. StakeInitPool
 *    irreversibly rotates cfg.marketauth to the pool PDA, so tag 86 MUST precede
 *    it (afterwards it is reachable only via the stake CPI proxy, stake tag 25).
 *  - BindInsuranceAuthority (stake tag 19) needs the pool PDA to already exist,
 *    so it MUST follow StakeInitPool. The creator still signs it as asset-0's
 *    insurance_authority (InitPool rotates marketauth, not insurance_authority).
 *
 * `updateFeeSplitIx` is null for a default split (no tx needed — defaults are
 * written at InitMarket). Exported so the sequence invariant can be unit-tested
 * without driving the whole wallet/RPC create flow.
 */
export function orderStakeTailInstructions<T>(
  preInitPool: T[],
  updateFeeSplitIx: T | null,
  initPoolIx: T,
  bindInsuranceIx: T,
): T[] {
  return [
    ...preInitPool,
    ...(updateFeeSplitIx ? [updateFeeSplitIx] : []),
    initPoolIx,
    bindInsuranceIx,
  ];
}

// BACKING-BUCKET SEEDING: both domains of asset 0 (long=2*assetIndex,
// short=2*assetIndex+1) are seeded to Fresh@MAX_BACKING_BUCKET_EXPIRY_SLOT via
// TopUpBackingBucket in Step 3, right after DepositCollateral lands (buckets are
// still Empty — nothing in Steps 0-5 calls TradeCpi). That defuses the
// freshness deadlock. The AMOUNT now comes from backingSeedPerDomain() rather
// than a flat 0.01 dust: the SHORT domain can never be topped up again once
// CreateLpVault rebinds backing_bucket_authority, so dust there meant shorts
// were permanently backed by one cent. See lib/market-params.ts.

/**
 * PERC-465: Fetch the current USD price for a token from Jupiter price API.
 * Used to push a real initial oracle price immediately after market creation.
 * Returns null on any failure — caller falls back to params.initialPriceE6.
 */
async function fetchJupiterPriceE6(ca: string): Promise<bigint | null> {
  // 1. Try Jupiter Lite API
  try {
    const resp = await fetch(
      `https://lite.jup.ag/v6/price?ids=${ca}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (resp.ok) {
      const json = await resp.json() as { data?: Record<string, { price?: number }> };
      const price = json.data?.[ca]?.price;
      if (price && isFinite(price) && price > 0) {
        return toE6(price);
      }
    }
  } catch { /* fall through */ }

  // 2. Fallback: DexScreener (covers Pump.fun + PumpSwap tokens Jupiter misses)
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (resp.ok) {
      const json = await resp.json() as { pairs?: Array<{ priceUsd?: string }> };
      const priceStr = json.pairs?.[0]?.priceUsd;
      const price = priceStr ? parseFloat(priceStr) : 0;
      if (price > 0 && isFinite(price)) {
        return toE6(price);
      }
    }
  } catch { /* fall through */ }

  return null;
}

/** Minimum vault seed required by percolator-prog before InitMarket (500_000_000 raw tokens). */
export const MIN_INIT_MARKET_SEED = 500_000_000n;

/**
 * BUG FIX (devnet flow-test 2026-07-01, flowtest/debug-maxassets-bisect.ts): the deployed
 * wrapper program rejects InitMarket with a raw ProgramError::InvalidAccountData ("invalid
 * account data for instruction" — no Custom error code, so parseMarketCreationError can't give
 * the user a useful message) whenever initial_margin_bps/maintenance_margin_bps are too low.
 * Bisected on-chain: 1000/500 bps (10x leverage) and 1100/550 both fail; 1200/600 (~8.33x) and
 * MARKET_PARAMS' proven values consistently succeed. This means EVERY market ever created
 * through this wizard at the previous default leverage range would have silently failed Step 0
 * with a cryptic error. 1500 bps (~6.67x max leverage) is enforced as a floor here — comfortably
 * above the proven-good 1200 boundary (the exact edge between 1100 and 1200 wasn't bisected
 * further) — regardless of what leverage the caller requests, so no create-market attempt can
 * hit this failure mode. If product wants to offer >6.67x leverage again, this needs a fresh
 * on-chain bisection first.
 */
/**
 * SUPERSEDED 2026-07-27. Kept only so nothing silently imports a stale floor.
 *
 * The 1500-bps (6.67x) floor above came from a bisection that concluded "10x
 * fails on-chain". That was a misdiagnosis: 10x fails only when paired with the
 * OLD hardcoded price-move budget (1 bps/slot x 500 slots = 500), which exceeds
 * what 500-bps maintenance margin can absorb. Re-bisected against the deployed
 * program with a compatible budget (4 x 100 = 400), **10x is accepted**. The
 * fresh bisection the comment above asks for is the MAX_PRICE_MOVE_BY_MARGIN
 * table in lib/market-params.ts.
 *
 * Leaving the floor in place was not neutral: `derived` sized the price-move
 * budget for the leverage the creator PICKED while InitMarket wrote the floored
 * margin, so a creator who chose 10x got a 6.67x market. Margin and budget now
 * both come from deriveMarketParams(), which makes them coherent by
 * construction.
 */
export const MIN_SAFE_INITIAL_MARGIN_BPS = 1500n;

/**
 * The on-chain initial_margin_bps this request will ACTUALLY be created with.
 *
 * Every leverage display (success screen, StepReview, markets DB `max_leverage`)
 * must go through this rather than the raw bps the user typed. Originally that
 * was BUG 16 (2026-07-06): create() floored the margin at 1500 but the displays
 * read the unfloored value, so a market advertised as 10x was initialized at
 * ~6.67x.
 *
 * The floor is gone (see MIN_SAFE_INITIAL_MARGIN_BPS above), but the reason for
 * this mirror is not: deriveMarketParams clamps leverage to [MIN_LEVERAGE_X,
 * MAX_LEVERAGE_X] and rounds margin UP, so the requested bps and the on-chain
 * bps can still differ. A pure function of the request — no retry/session
 * state — so it is safe to call before submission.
 */
export function flooredInitialMarginBps(requestedBps: number): number {
  const lev = requestedBps > 0 ? 10_000 / requestedBps : MIN_LEVERAGE_X;
  return deriveMarketParams(lev, 0n, 1_000_000n).initialMarginBps;
}

export interface VammParams {
  spreadBps: number;
  impactKBps: number;
  maxTotalBps: number;
  liquidityE6: string;
}

export interface CreateMarketParams {
  mint: PublicKey;
  initialPriceE6: bigint;
  lpCollateral: bigint;
  insuranceAmount: bigint;
  oracleFeed: string;
  invert: boolean;
  tradingFeeBps: number;
  /**
   * Fee-collection split (bps of the trade fee T). When provided AND different
   * from the on-chain defaults, an UpdateFeeSplit (wrapper tag 86) instruction is
   * sent BEFORE StakeInitPool (which irreversibly rotates marketauth to the pool
   * PDA, after which tag 86 is only reachable via the stake CPI proxy). Omit to
   * keep the on-chain defaults (creator 1600 / LP 4800 / insurance 1600), which
   * are written at InitMarket and need no tx. Must satisfy validateFeeSplit
   * (sum == 8000, creator ≤ 3600, LP ≥ 3200, insurance ≥ 1200) or the wrapper
   * rejects it with Custom(52)/Custom(51).
   */
  feeSplit?: {
    creatorShareBps: number;
    lpShareBps: number;
    insuranceShareBps: number;
  };
  initialMarginBps: number;
  /** Number of trader slots (256, 1024, 4096). Defaults to 4096 if omitted.
   *  IMPORTANT: Must match the compiled MAX_ACCOUNTS of the target program binary.
   *  The default devnet program is compiled for 4096 accounts. */
  maxAccounts?: number;
  /** Slab data size in bytes. Calculated from maxAccounts if omitted. */
  slabDataSize?: number;
  /** Token symbol for dashboard */
  symbol?: string;
  /** Token name for dashboard */
  name?: string;
  /** Token decimals */
  decimals?: number;
  /** vAMM configuration — if provided, uses custom params instead of defaults */
  vammParams?: VammParams;
  /** Mainnet token CA — used by oracle keeper to fetch real-time prices (PERC-465) */
  mainnetCA?: string;
  /** PERC-470: Oracle mode — determines how price is fed to the market */
  oracleMode?: "pyth" | "hyperp" | "admin" | "keeper";
  /** PERC-470: DEX pool address for hyperp mode (PumpSwap/Raydium/Meteora) */
  dexPoolAddress?: string;
  /** PERC-470: Base vault address for hyperp mode (PumpSwap) */
  dexBaseVault?: string;
  /** PERC-470: Quote vault address for hyperp mode (PumpSwap) */
  dexQuoteVault?: string;
  /**
   * Keeper oracle: DEX pool type (raydium-clmm / meteora-dlmm / pumpswap).
   * Used by the keeper registration call after market creation.
   */
  dexType?: string;
}

export interface CreateMarketState {
  /**
   * Why the one-approval batched launch fell back to the six-prompt sequential
   * path, or null when it did not. Recorded so a user who signs six times can
   * say WHY without having had devtools open. See #2586.
   */
  /**
   * REQUIRED, not optional. Optional meant the compiler guarded only the
   * producer: deleting the `setState` that stores the reason, or the clear that
   * stops a stale one surfacing on a retry, type-checked in silence. Required
   * forces the initial state and reset() to name it, so every state
   * construction has to decide.
   */
  batchFallbackReason: string | null;
  step: number;
  stepLabel: string;
  txSigs: string[];
  slabAddress: string | null;
  error: string | null;
  loading: boolean;
  /** Devnet mint address (different from mainnet CA) */
  devnetMint: string | null;
  /**
   * GH#1761 (legacy): previously set to true when the old "Insurance LP Mint" step
   * failed after exhausting retries. That instruction was removed (see the Step 4/5
   * comment block in create() below — CreateLpVault/StakeInitPool replaced it and are
   * NOT treated as non-fatal; they use the same hard-error/retry path as every other
   * step). Kept for backwards-compatible UI wiring; never set to true by create().
   */
  insuranceMintFailed: boolean;
  /**
   * GH#2514: set when the sequential path's backing-bucket seeding failed.
   *
   * That step is deliberately non-fatal (see the Step 3 comment in create()) so
   * a transient RPC error cannot strand an otherwise-live market. But it was
   * ALSO silent: the launch went on to report an unqualified "Market created!"
   * while both backing domains were left unseeded.
   *
   * That was defensible when the seed was dust. It is not now the seed is
   * `backingSeedPerDomain(lp)` per domain — 100% of LP collateral each at the
   * current policy, so a silent failure leaves the creator's market short two
   * allocations totalling twice their LP.
   *
   * Non-fatal is kept; silent is not. The launch still succeeds, and the
   * success screen says what did not happen so the creator can retry or
   * backfill rather than believing the market is fully seeded.
   */
  backingSeedFailed: boolean;
  /** Keeper oracle mode: true when oracle_authority was delegated to keeper */
  keeperDelegated: boolean;
  /** Keeper registration result message */
  keeperMessage: string | null;
  /** True while a manual "Retry registration" call (see retryKeeperRegistration) is in flight. */
  keeperRegistering: boolean;
  /**
   * Batch-launch UI phase (fresh-launch fast path only — see
   * `attemptFreshBatchedLaunch` below). Sequential/resume flows never set this
   * away from "idle", so `LaunchProgress` falls back to its original
   * per-step (0-5) rendering for those — this is purely additive UI state,
   * `step`/`lastStep` remain the single source of truth the resume machinery
   * (RecoverSolBanner, useStuckSlabs, updateInFlightStep) reads.
   */
  phase: "idle" | "preparing" | "awaiting-signature" | "landing" | "done";
  /** "landing" phase only: 1-based index of the transaction currently confirming. */
  landingIndex: number;
  /** Human-readable market-creation step names, one per batched tx, in order. */
  landingLabels?: string[];
  /** "landing" phase only: total transactions in this batch (4-5 depending on oracle mode). */
  landingTotal: number;
}

/**
 * slab -> the registration payload built at launch time.
 *
 * The retry path has no CreateMarketParams, so without this a retry re-registers
 * with only symbol + pool and the row keeps the indexer's column defaults —
 * 10x/10bps regardless of what the creator actually chose. Stashing the payload
 * lets a retry replay the SAME registration rather than a partial one.
 *
 * Module-level and per-slab: it survives a failed launch on the same page,
 * which is when Retry is used. A full page reload loses it and the retry falls
 * back to the partial shape.
 */
const launchRegistrationPayloads = new Map<string, MarketRegistrationPayload>();

/** Minimal shape retryKeeperRegistration needs to re-run keeper-register for an
 *  already-live slab — a subset of CreateMarketParams, since the market is already
 *  on-chain and everything else about it is fixed. */
export interface KeeperRegisterRetryParams {
  slabAddress: string;
  mainnetCA?: string | null;
  dexPoolAddress: string;
  dexType?: string | null;
  symbol?: string | null;
  /** Full markets-row payload from buildMarketRegistrationPayload().
   *  keeper-register writes the row, so without this the row falls back to
   *  column defaults (max_leverage 10, trading_fee_bps 10) and loses
   *  oracle_authority / initial_price_e6 / lp_collateral entirely. Optional so
   *  the retry path, which has no CreateMarketParams, still compiles — it
   *  re-registers an already-listed market and only needs the pool binding. */
  payload?: MarketRegistrationPayload | null;
}

interface KeeperRegisterOutcome {
  registered: boolean;
  message: string;
}

/**
 * Signs the H1v2 stateless deployer proof and POSTs /api/playground/keeper-register.
 * Extracted as a standalone function (not a hook) so it can be called both from
 * create()'s Step 4/5 gap and from retryKeeperRegistration() below without
 * duplicating the sign+fetch logic — the two call sites previously used to diverge
 * (create() silently posted without a signature when wallet.signMessage was
 * unavailable; retry didn't exist at all).
 *
 * NEVER throws — always resolves with an outcome describing what happened, so
 * callers can surface it directly as UI state.
 *
 * `precomputedProof` (batching fast path, 2026-07-12): the fresh-launch batch
 * pipeline (see `attemptFreshBatchedLaunch`) signs the H1v2 stateless proof
 * message UPFRONT — bursted alongside the markets-nonce signMessage prompt,
 * before the batch tx signature — rather than at this call site (which in the
 * batched flow runs well after M1 has already landed). When supplied, this
 * skips the wallet.signMessage step entirely and posts with the given
 * deployer/signature pair; the sequential path and retryKeeperRegistration()
 * never pass it, so their sign-at-call-time behavior is unchanged.
 */
async function registerMarketWithKeeper(
  wallet: {
    publicKey: PublicKey | null;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  },
  params: KeeperRegisterRetryParams,
  precomputedProof?: { deployer: string; signature: string },
): Promise<KeeperRegisterOutcome> {
  if (!wallet.publicKey) {
    return {
      registered: false,
      message: "Wallet not connected — connect your wallet, then click Retry registration.",
    };
  }

  let keeperDeployer: string;
  let keeperSignature: string;

  if (precomputedProof) {
    keeperDeployer = precomputedProof.deployer;
    keeperSignature = precomputedProof.signature;
  } else {
  // BUG FIX (2026-07-09): previously this fell through with keeperSignature = null
  // and POSTed the request anyway, minus the `signature` field — the route always
  // 400'd with "Missing required fields: deployer, signature" and the wizard
  // reported a generic non-actionable warning. Now that useWalletCompat.ts wires a
  // real signMessage for Privy (the primary auth path), this should be rare, but
  // some wallet-standard adapters genuinely don't implement it — surface that
  // explicitly instead of silently sending a doomed request.
  if (!wallet.signMessage) {
    return {
      registered: false,
      message:
        "Your connected wallet can't sign messages, so it can't prove it administers this " +
        "market. The market is live on-chain but won't be priced until it's registered — " +
        "try reconnecting your wallet, then click Retry registration.",
    };
  }

  keeperDeployer = wallet.publicKey.toBase58();
  try {
    // H1v2 auth: keeper-register verifies slab ownership via a STATELESS
    // deployer-signed proof — sign `keeper-register:<slabAddress>:<unix-minute>`
    // and the route independently reconstructs + verifies it against a small
    // window around its own clock. No server-stored nonce (see route.ts header).
    // #2505 / #2468: the proof binds the registration PARAMETERS, not just the
    // slab — otherwise one signature authorises this slab against any pool.
    // Built by the shared module so this and the route cannot drift.
    const unixMinute = Math.floor(Date.now() / 60_000);
    const proofMsg = buildKeeperRegisterProofMessage(
      {
        slabAddress: params.slabAddress,
        dexPoolAddress: params.dexPoolAddress,
        mainnetCA: params.mainnetCA ?? "",
        // MUST be the normalized value, because that is what the body below
        // carries and therefore what the route binds. Signing the raw dexId
        // while sending the normalized one would fail verification on every
        // market whose DexScreener id differs from the keeper vocabulary.
        dexType: normalizeDexType(params.dexType) ?? params.dexType ?? "",
        symbol: params.symbol ?? undefined,
        // This path sends no label, so both sides bind the empty string. Left
        // explicit rather than omitted: the canonicaliser encodes an absent
        // optional as empty precisely so "no label" and "label removed" cannot
        // share a signature.
        label: undefined,
      },
      unixMinute,
    );
    const sig = await wallet.signMessage(proofMsg);
    keeperSignature = Buffer.from(sig).toString("base64");
  } catch (sigErr) {
    // Sign throws/rejects (user declined, wallet popup closed, timeout, etc.) —
    // don't proceed with an unsigned request. Actionable + retryable.
    console.warn("[useCreateMarket] keeper-register sign failed:", sigErr);
    return {
      registered: false,
      message:
        "Signature request was cancelled or failed — the market is live on-chain but won't " +
        "be priced until it's registered. Click Retry registration to try again.",
    };
  }
  } // end precomputedProof ? ... : sign-here

  try {
    const keeperRegResp = await fetch("/api/playground/keeper-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slabAddress: params.slabAddress,
        mainnetCA: params.mainnetCA ?? null,
        dexPoolAddress: params.dexPoolAddress,
        // params.dexType carries DexScreener's raw dexId ("meteora",
        // "raydium") — normalize to the keeper vocabulary or the route
        // 400s and the market is orphaned (no price, no name).
        // No "raydium-clmm" fallback: it is only a HINT (the route classifies
        // the pool by its on-chain owner and ignores this when it can), and
        // Raydium is blocked for new markets — labelling an unknown pool as
        // Raydium would be both wrong and, if the RPC check failed, the exact
        // value the route now rejects. Send what we actually know, or nothing.
        dexType: normalizeDexType(params.dexType) ?? params.dexType ?? null,
        symbol: params.symbol ?? null,
        // The markets-row fields. keeper-register writes that row now, so
        // without this the row takes column defaults and the board shows the
        // wrong leverage/fee. Null on the retry path (already-listed market).
        payload: params.payload ?? null,
        // H1v2 deployer proof (stateless, see above)
        deployer: keeperDeployer,
        signature: keeperSignature,
      }),
    });
    const keeperRegData = (await keeperRegResp.json()) as {
      registered?: boolean;
      message?: string;
      error?: string;
    };
    const registered = keeperRegData.registered ?? false;
    // Error responses put their reason in `error`, not `message` — a 400/502 with
    // no `message` previously left the wizard showing nothing.
    const message =
      keeperRegData.message ??
      (keeperRegData.error
        ? `Keeper registration failed: ${keeperRegData.error} — the market is live on-chain but won't be priced or listed until it's registered.`
        : registered
          ? "Registered — the keeper will pick this up on its next poll."
          : "Keeper registration failed — the market is live on-chain but won't be priced or listed until it's registered.");
    console.log("[useCreateMarket] Keeper registration:", keeperRegData);
    return { registered, message };
  } catch (keeperErr) {
    console.warn("[useCreateMarket] Keeper registration failed:", keeperErr);
    return {
      registered: false,
      message:
        "Keeper registration failed — the market is live on-chain but won't be priced or listed until it's registered. Click Retry registration to try again.",
    };
  }
}

// ============================================================================
// Fresh-launch batching (2026-07-12)
// ============================================================================
//
// GOAL: collapse the ~12 wallet approvals + 2 signMessage prompts a genuinely
// FRESH quick-launch requires (see the sequential Steps 0-5 below) into ONE
// signAllTransactions batch approval + the same 2 signMessage prompts,
// bursted immediately before it. This function is ONLY attempted when
// `create()` is called with `retryFromStep === undefined` — i.e. a real
// "LAUNCH MARKET" click, never a resume/retry (those always pass an explicit
// step number and keep using the battle-tested sequential per-step code
// below unchanged, including every idempotency check it relies on to resume
// a partially-created market safely).
//
// Maps the 12-tx sequential flow to 6-7 independent transactions:
//   M1  = createAccount(slab)+createATA+InitMarket+SetNftProgramId
//   cosignTx (keeper mode only) = the server-built keeper co-sign tx, wallet-
//         signed inside the same batch, otherwise untouched
//   M2  = createAccount(portfolio)+InitUser+createAccount(ctx)+
//         SetMatcherConfig+InitMatcherCtx
//   M3a = DepositCollateral + 2x TopUpBackingBucket (deadlock-prevention seed)
//   M3b = TopUpInsurance + PermissionlessCrank (best-effort/non-fatal, same
//         as the sequential path's own tail — its failure must never roll
//         back the deposit, per the H9/W3 fix, so it's ALWAYS its own tx)
//   M4a = CreateLpVault alone — the "Creating Earn vault..." step. SPLIT OUT
//         (2026-09-25) from what used to be a single M4 bundling this with the
//         entire stake-pool tail below: that bundle was the largest/most
//         fragile tx in the pipeline (up to 6 ixs, 3 signers, ~18 accounts)
//         and is what tester reports of "Step 5 Create Earn vault — Internal
//         error" were hitting. Mirrors the sequential/resume path, which has
//         always kept these as two separate sends.
//   M4b = createAccount(stakeLpMint)+createAccount(stakeVault)+
//         [UpdateFeeSplit]+StakeInitPool+BindInsuranceAuthority — broadcast
//         only after M4a has landed AND keeper-register has returned, since
//         StakeInitPool irreversibly rotates on-chain marketauth away from
//         the creator wallet and both CreateLpVault and keeper-register's H1
//         check require marketauth === deployer.
//
// `updateInFlightStep` is called with the SAME lastStep values the resume
// machinery already expects after each landing (M1→2, M2→3, M3(a+b)→4,
// M4a→5, M4b→6 — see inFlightMarket.ts's lastStep doc and
// RecoverSolBanner.tsx), so a mid-pipeline failure falls back cleanly onto
// the existing RecoverSolBanner/handleRetry resume flow (which always passes
// an explicit step and therefore uses the sequential code, reading the same
// idempotency state this batch path left behind).
//
// FALLBACK CONTRACT: any failure BEFORE the first transaction broadcasts
// (capability gap, network hiccup, preflight failure, or the user declining
// the single batch-approval popup) returns "fallback" and nothing on-chain
// or in localStorage has changed — `create()` falls through to the
// sequential path in the SAME call, so the user always reaches a working
// flow (worst case: today's N-popup experience, never a dead end). Once ANY
// tx has broadcast, a failure is "fatal": state.error is set and the user
// must use the existing resume/retry UI — this code NEVER re-broadcasts a
// stale pre-signed transaction.

/** Rent-exemption lamports for a handful of FIXED account sizes used by every
 *  market launch. These are Solana protocol constants for a given byte size
 *  (they don't change mid-session) — cached module-level so the preflight
 *  step of a batched launch (and any retry within the same page load) never
 *  re-pays the RPC round-trip for a number it already knows. */
const rentExemptionCache = new Map<number, number>();
async function getCachedRentExemption(connection: Connection, sizeBytes: number): Promise<number> {
  const cached = rentExemptionCache.get(sizeBytes);
  if (cached !== undefined) return cached;
  const rent = await connection.getMinimumBalanceForRentExemption(sizeBytes);
  rentExemptionCache.set(sizeBytes, rent);
  return rent;
}

/** Wallet shape `attemptFreshBatchedLaunch` needs — a narrowed, publicKey-
 *  guaranteed subset of `WalletApi` (the caller has already checked
 *  wallet.publicKey/signTransaction before generating the slab keypair). */
interface FreshBatchWallet {
  publicKey: PublicKey;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

interface FreshBatchContext {
  connection: Connection;
  wallet: FreshBatchWallet;
  programId: PublicKey;
  /** The freshly-generated slab keypair (create() already generated this
   *  before calling in — see the `retryFromStep === undefined` branch). */
  slabKp: Keypair;
  params: CreateMarketParams;
  isDevnetEnv: boolean;
  isKeeperOracle: boolean;
  isAdminOracle: boolean;
  isHyperpOracle: boolean;
  oracleMode: "pyth" | "hyperp" | "admin" | "keeper";
  setState: (updater: (s: CreateMarketState) => CreateMarketState) => void;
  /**
   * GH#2623: set by `create()` from a fresh `AbortController` and aborted by
   * `cancelInFlightLaunch()` (called on CreateMarketWizard unmount). Checked
   * before `broadcastTailTx` re-signs the tail (`recoverTailFrom`) so leaving
   * `/create` stops the wallet-popup loop instead of it continuing on a page
   * the user is no longer looking at.
   */
  abortSignal?: AbortSignal;
}

/**
 * A one-line, user-safe explanation of why the batched launch fell back.
 *
 * Three things the raw `err.message` got wrong:
 *
 *  - A REJECTED approval is not an unavailable fast path. Declining the single
 *    batch prompt throws before broadcast, so it lands here — and saying
 *    "one-approval launch unavailable" tells the user the opposite of what
 *    happened. It was available; they declined it.
 *  - `err.message` is `""` for `new Error()` and for several wallet-adapter
 *    errors. An empty string satisfies `reason: string` and then renders as
 *    nothing, which is exactly the silence this whole change exists to remove.
 *  - Server messages are written for operators. "Is PLAYGROUND_KEEPER_KEYPAIR
 *    set in server env?" is a question for whoever runs the deployment, not
 *    for someone launching a market.
 *
 * Never throws: `String(err)` can raise on a null-prototype object, a Proxy,
 * or a throwing `Symbol.toPrimitive`, and this runs outside any try.
 */
export function describeBatchFallback(err: unknown): string {
  let raw = "";
  try {
    raw = err instanceof Error ? (err.message || err.name) : String(err);
  } catch {
    raw = "";
  }
  if (/user rejected|transaction cancelled|WalletSignTransactionError/i.test(raw)) {
    return "you declined the single-approval signature";
  }
  // Drop the operator-facing tail; the full text still goes to the console.
  const cleaned = raw.replace(/\s*Is [A-Z_]+ set in server env\?\s*/g, " ").trim();
  return cleaned || "the wallet or network did not complete the batch";
}

type FreshBatchOutcome =
  | { status: "success" }
  /**
   * Nothing was broadcast, so the sequential path runs instead.
   *
   * `reason` is NOT decoration. This branch used to discard the error
   * entirely, so the only visible symptom was the user signing SIX wallet
   * prompts instead of one, with nothing anywhere saying why — unreproducible
   * from a bug report, and invisible to anyone without devtools open. Every
   * caller must record it. See #2586.
   */
  | { status: "fallback"; reason: string }
  | { status: "fatal" };

// ---- Blockhash-expiry recovery for the batched launch's tail -------------
//
// M1/M2/M3a/M3b/M4 are all built against the SAME shared blockhash (fetched
// once, below) and signed in the ONE wallet approval, but broadcast+confirmed
// SEQUENTIALLY afterwards — a keeper-register network round-trip is even
// awaited between M3b and M4 (see the `keeperRegisterPromise` await below).
// That means the tail (especially M4 = StakeInitPool) can reach
// `broadcastSignedTx` well after the shared blockhash's ~60-90s validity
// window, hard-failing with "Blockhash not found" even though M1 (the slab)
// already landed. `TailTxDescriptor` retains exactly what's needed to REBUILD
// a not-yet-landed tx against a fresh blockhash — instructions/computeUnits
// for `buildBatchTx`, plus the keypairs that must `partialSign` it AFTER the
// wallet re-signs (Privy strips unknown sigs added before its own signing
// flow — see the ordering note further down). cosignTx is deliberately NOT a
// descriptor: it's server-built against its own blockhash and broadcast early
// (2nd, low-risk) — an expiry there just surfaces as today's error.
interface TailTxDescriptor {
  label: string;
  instructions: TransactionInstruction[];
  computeUnits: number;
  signers: Keypair[];
}

/** Cap total blockhash-refresh recoveries per launch attempt so a pathological
 *  RPC (or a wallet that keeps stalling the re-approval popup) can't loop
 *  forever — after this many, a persistent expiry rethrows and surfaces as
 *  the existing fatal/resumable error path. */
const MAX_BLOCKHASH_RECOVERIES = 2;

/**
 * Single source of truth for the market-registration payload.
 *
 * The batched fast path and the sequential fallback both POST this object to
 * /api/markets AND sign a canonical encoding of it (buildMarketRegistrationMessage,
 * #2387). The signed bytes and the POSTed bytes MUST be byte-identical or the
 * server's signature check 401s — so the payload must be built in exactly ONE
 * place. Previously each path hand-wrote its own literal (they had already
 * drifted cosmetically on the oracle_authority fallback); this factory removes
 * any chance of a future field being added to one and forgotten on the other.
 */
function buildMarketRegistrationPayload(args: {
  slabAddress: string;
  params: CreateMarketParams;
  deployer: string;
  oracleMode: "pyth" | "hyperp" | "admin" | "keeper";
  isAdminOracle: boolean;
  isDevnetEnv: boolean;
}): MarketRegistrationPayload {
  const { slabAddress, params, deployer, oracleMode, isAdminOracle, isDevnetEnv } = args;
  return {
    slab_address: slabAddress,
    mint_address: params.mint.toBase58(),
    symbol: params.symbol ?? "UNKNOWN",
    name: params.name ?? "Unknown Token",
    decimals: params.decimals ?? 6,
    deployer,
    oracle_mode: oracleMode,
    dex_pool_address: params.dexPoolAddress ?? null,
    // Admin-oracle markets on devnet are cranked by the shared crank wallet;
    // otherwise the deployer is its own oracle authority. (deployer === the
    // connected wallet, so this matches the former walletPk.toBase58() literal.)
    //
    // A "keeper" market counts here. On devnet it is created in AUTH_MARK/admin
    // mode and its oracle authority is DELEGATED to the keeper — that is what
    // the mode means. Testing `isAdminOracle` alone (oracleMode === "admin")
    // excluded exactly those markets, so the row recorded oracle_authority=null
    // for the ones the keeper actually drives. Fauci's row shows the symptom.
    oracle_authority: (isAdminOracle || oracleMode === "keeper")
      ? (isDevnetEnv && getConfig().crankWallet ? getConfig().crankWallet : deployer)
      : null,
    initial_price_e6: params.initialPriceE6.toString(),
    // BUG 16: advertise the FLOORED margin actually enforced on-chain, not the
    // raw requested bps — see flooredInitialMarginBps.
    max_leverage: params.initialMarginBps > 0
      ? leverageFromMarginBps(flooredInitialMarginBps(params.initialMarginBps))
      : 1,
    trading_fee_bps: Number(params.tradingFeeBps),
    lp_collateral: params.lpCollateral.toString(),
    mainnet_ca: params.mainnetCA ?? null,
  };
}

async function attemptFreshBatchedLaunch(ctx: FreshBatchContext): Promise<FreshBatchOutcome> {
  const { connection, wallet, programId, slabKp, params, isDevnetEnv, isKeeperOracle, isAdminOracle, isHyperpOracle, oracleMode, setState, abortSignal } = ctx;
  const walletPk = wallet.publicKey;
  const slabPk = slabKp.publicKey;
  let broadcastStarted = false;
  // Every risk parameter for this market, derived from the creator's leverage
  // and LP seed. Nothing below hand-picks a price-move rate or an LP cap.
  const derived = deriveMarketParams(
    params.initialMarginBps > 0 ? 10_000 / params.initialMarginBps : MIN_LEVERAGE_X,
    params.lpCollateral,
    params.initialPriceE6,
  );
  // Collateral seeded into EACH backing domain. Must be real, not dust — the
  // SHORT domain is unfundable after CreateLpVault. See lib/market-params.ts.
  const backingSeed = backingSeedPerDomain(params.lpCollateral);

  try {
    setState((s) => ({ ...s, loading: true, phase: "preparing", stepLabel: "Preparing market launch..." }));

    const [vaultPda] = deriveVaultAuthority(programId, slabPk);
    const vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
    const userAta = await getAssociatedTokenAddress(params.mint, walletPk);
    const [nftRegistryPda] = deriveNftRegistry(programId, slabPk);
    const matcherProgramId = new PublicKey(getConfig().matcherProgramId);
    const [lpVaultRegistry] = deriveLpVaultRegistry(programId, slabPk);
    const [lpVaultMint] = deriveInsuranceLpMint(programId, slabPk);
    const stakeProgramId = new PublicKey(
      (getConfig() as { vaultProgramId?: string }).vaultProgramId ??
        "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3",
    );
    const [stakePoolPda] = deriveStakePool(slabPk, stakeProgramId);
    const [stakeVaultAuth] = deriveStakeVaultAuth(stakePoolPda, stakeProgramId);

    const lpPortfolioKp = Keypair.generate();
    const matcherCtxKp = Keypair.generate();
    const stakeLpMintKp = Keypair.generate();
    const stakeVaultKp = Keypair.generate();

    const [matcherDelegatePk] = deriveMatcherDelegate(
      programId, slabPk, lpPortfolioKp.publicKey, walletPk, matcherProgramId, matcherCtxKp.publicKey,
    );

    // ---- Fire everything BEFORE any popup (orchestration step 1) ---------
    const preFundPromise = isDevnetEnv
      ? fetch("/api/devnet-pre-fund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // GH#2592: send the amounts this launch will actually spend. Without
          // them the route funds for a fixed reference launch, which is both
          // wrong for other LP sizes and understated for that one.
          body: JSON.stringify({
            mintAddress: params.mint.toBase58(),
            walletAddress: walletPk.toBase58(),
            lpCollateral: params.lpCollateral.toString(),
            insuranceAmount: params.insuranceAmount.toString(),
          }),
        })
      : Promise.resolve(null);

    const cosignPromise = isKeeperOracle
      ? fetch("/api/playground/keeper-cosign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deployer: walletPk.toBase58(),
            slabAddress: slabPk.toBase58(),
            initialPriceE6: params.initialPriceE6.toString(),
            assetIndex: 0,
            // The slab doesn't exist yet — this request is made before M1 is even
            // signed. Without `fresh` the route read the (missing) slab, returned
            // 404 "market account not found", and every launch fell back to six
            // approvals. With it the route uses asset 0's fixed post-M1 values.
            fresh: true,
          }),
        })
      : Promise.resolve(null);

    prewarmTxLanding(connection);

    const rentPromise = Promise.all([
      getCachedRentExemption(connection, params.slabDataSize ?? DEFAULT_SLAB_SIZE),
      getCachedRentExemption(connection, V17_PORTFOLIO_ACCOUNT_LEN),
      getCachedRentExemption(connection, MATCHER_CONTEXT_LEN),
      getCachedRentExemption(connection, MINT_SIZE),
      getCachedRentExemption(connection, ACCOUNT_SIZE),
    ]);
    const balancePromise = connection.getBalance(walletPk);

    // 1. Devnet pre-fund MUST complete before we build/broadcast anything —
    //    it funds the wallet's collateral ATA for the LP deposit + insurance.
    if (isDevnetEnv) {
      const preFundResp = await preFundPromise;
      if (preFundResp && !preFundResp.ok) {
        const err = await preFundResp.json().catch(() => ({ error: "Unknown error" }));
        const { error: pfError, nextClaimAt } = err as { error?: string; nextClaimAt?: string | null };
        // The 429 body carries `nextClaimAt` — the retry time. Dropping it
        // left the user with "Already pre-funded recently" and no idea when
        // "recently" stops, which is the single fact they need.
        const when = nextClaimAt ? ` Try again after ${nextClaimAt}.` : "";
        throw new Error(`Devnet pre-fund failed: ${pfError ?? preFundResp.status}.${when}`);
      }
    }

    // 3. Keeper co-sign (keeper oracle mode only) — fatal, matching the
    //    sequential path's own hard throw for this call.
    let cosignTx: Transaction | null = null;
    if (isKeeperOracle) {
      const cosignResp = await cosignPromise;
      if (!cosignResp || !cosignResp.ok) {
        const errData = cosignResp ? await cosignResp.json().catch(() => ({ error: "co-sign failed" })) : { error: "network error" };
        throw new Error(
          `Keeper co-sign failed (${cosignResp?.status ?? "network error"}): ${(errData as { error?: string }).error ?? "unknown"}. ` +
          `Is PLAYGROUND_KEEPER_KEYPAIR set in server env?`,
        );
      }
      const { partialTxBase64 } = (await cosignResp.json()) as { partialTxBase64: string };
      cosignTx = Transaction.from(Buffer.from(partialTxBase64, "base64"));
    }

    // 4. Burst the signMessage prompt NOW, immediately before the batch — the
    //    proof tolerates the ~15-30s the pipeline takes to actually use it (the
    //    keeper proof window is -5min/+1min server-side — see
    //    keeper-register/route.ts).
    //
    //    This used to burst TWO prompts. The second signed a markets-challenge
    //    nonce for POST /api/markets, which no longer exists — keeper-register
    //    writes the row under the marketauth proof instead. That made the whole
    //    challenge fetch + payload build + signature dead work, and it cost the
    //    user a wallet prompt that fed nothing.
    let keeperProofSignature: string | null = null;
    if (isKeeperOracle && params.dexPoolAddress && wallet.signMessage) {
      try {
        // #2505 / #2468 — same bound message as the retry path above.
        const unixMinute = Math.floor(Date.now() / 60_000);
        const proofMsg = buildKeeperRegisterProofMessage(
          {
            slabAddress: slabPk.toBase58(),
            dexPoolAddress: params.dexPoolAddress ?? "",
            mainnetCA: params.mainnetCA ?? "",
            dexType: normalizeDexType(params.dexType) ?? params.dexType ?? "",
            symbol: params.symbol ?? undefined,
            label: undefined,
          },
          unixMinute,
        );
        const sig = await wallet.signMessage(proofMsg);
        keeperProofSignature = Buffer.from(sig).toString("base64");
      } catch { /* non-fatal — the "Retry registration" button covers this */ }
    }

    const [slabRent, portfolioRent, matcherCtxRent, mintRent, tokenAcctRent] = await rentPromise;
    const solBalance = await balancePromise;
    const effectiveSlabSize = params.slabDataSize ?? DEFAULT_SLAB_SIZE;
    const totalRent = slabRent + portfolioRent + matcherCtxRent + mintRent + tokenAcctRent;
    const minSolRequired = totalRent + 20_000_000; // rent + ~0.02 SOL for 5-6 tx fees/priority fees
    if (solBalance < minSolRequired) {
      if (isDevnetEnv) {
        setState((s) => ({ ...s, stepLabel: "Airdropping SOL for slab rent..." }));
        const airdropSig = await connection.requestAirdrop(
          walletPk,
          Math.max(2_000_000_000, minSolRequired - solBalance + 500_000_000),
        );
        const airdropConfirm = await connection.confirmTransaction(airdropSig, "confirmed");
        if (airdropConfirm.value.err) {
          throw new Error(`Airdrop transaction failed on-chain: ${JSON.stringify(airdropConfirm.value.err)}`);
        }
      } else {
        throw new Error(
          `Insufficient SOL. You need ~${(minSolRequired / 1e9).toFixed(3)} SOL but your wallet has ` +
          `${(solBalance / 1e9).toFixed(3)} SOL.`,
        );
      }
    }

    // ---- Build all txs against ONE fresh blockhash -----------------------
    const [blockhash, priorityFee] = await Promise.all([
      getFreshBlockhash(connection, true),
      getPriorityFee(connection),
    ]);

    // Margin comes from the SAME derivation as the price-move budget below, so
    // the two can never disagree (see lib/market-params.ts).
    const initialMarginBps = BigInt(derived.initialMarginBps);
    // WRITE-ONCE PARAMETERS.
    //
    // Everything below is fixed for the life of the market — InitMarket runs
    // once and there is no instruction to change these afterwards. That is
    // exactly how the 6.67x leverage cap and the missing LP caps survived for
    // months: a value typed here is invisible and permanent. Anything not
    // derived from the creator's choice is listed with why it is safe to pin.
    //
    //  hMin/hMax, minNonzeroMmReq/ImReq  dust + health bounds; below these a
    //                                    position is not worth gas to maintain.
    //  liquidationFee 50 bps, cap $10k   standard; minLiquidationAbs 0 lets any
    //                                    size be liquidated rather than
    //                                    stranding dust positions.
    //  maxAbsFundingE9PerSlot: "0"       funding is deliberately OFF. Trades
    //                                    settle at the pushed AuthMark, which
    //                                    IS the reference price, so there is no
    //                                    perp-vs-spot basis for funding to
    //                                    correct. A non-zero cap here would let
    //                                    a rate accrue against nothing.
    //  maintenanceFeePerSlot: "0"        no rent on open positions.
    //  chunk/lifetime limits             settlement batching; sized so a
    //                                    bankrupt close fits in one tx.
    //
    // Verified 2026-07-28: with these EXACT args, every leverage the wizard
    // offers (2..10x) simulates ACCEPTED against the deployed program, so no
    // creator choice can produce a config InitMarket rejects.
    const v17InitArgs: InitMarketV17Args = {
      maxPortfolioAssets: V17_MAX_PORTFOLIO_ASSETS,
      hMin: "1000",
      hMax: "100000",
      initialPrice: params.initialPriceE6.toString(),
      minNonzeroMmReq: "1000000",
      minNonzeroImReq: "2000000",
      maintenanceMarginBps: String(derived.maintenanceMarginBps),
      initialMarginBps: initialMarginBps.toString(),
      maxTradingFeeBps: BigInt(params.tradingFeeBps).toString(),
      tradeFeeBaseBps: BigInt(params.tradingFeeBps).toString(),
      liquidationFeeBps: "50",
      liquidationFeeCap: "10000000000",
      minLiquidationAbs: "0",
      // Auto-derived from the creator's leverage — see lib/market-params.ts.
      // Was hardcoded 1 / 500, which froze new positions for ~17 min after a
      // 26% move (verified causally on devnet 2026-07-27).
      maxPriceMoveBpsPerSlot: String(derived.maxPriceMoveBpsPerSlot),
      maxAccrualDtSlots: String(derived.maxAccrualDtSlots),
      maxAbsFundingE9PerSlot: "0",
      minFundingLifetimeSlots: "500",
      maxAccountBSettlementChunks: "10",
      maxBankruptCloseChunks: "10",
      maxBankruptCloseLifetimeSlots: "500",
      publicBChunkAtoms: "1000000000000",
      maintenanceFeePerSlot: "0",
    };

    // M1: createAccount(slab) + createATA + InitMarket + SetNftProgramId
    const createSlabIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: slabPk,
      lamports: slabRent, space: effectiveSlabSize, programId,
    });
    const createAtaIx = createAssociatedTokenAccountInstruction(walletPk, vaultAta, vaultPda, params.mint);
    const initMarketIx = buildIx({
      programId,
      // v18 InitMarket takes exactly 3 accounts [admin, slab, mint] — the vault
      // ATA, token program, clock, rent, vault PDA and system program that v17
      // required were dropped (see ACCOUNTS_INIT_MARKET in the v18 SDK, and the
      // proven newmarkets.ts seed). Passing the old 9-account array tripped the
      // SDK's "Account count mismatch: expected 3, got 9" guard at step 1.
      keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, {
        admin: walletPk,
        slab: slabPk,
        mint: params.mint,
      }),
      data: encodeInitMarket(v17InitArgs),
    });
    const setNftProgramIdIx = buildIx({
      programId,
      keys: [
        { pubkey: walletPk, isSigner: true, isWritable: true },
        { pubkey: slabPk, isSigner: false, isWritable: false },
        { pubkey: nftRegistryPda, isSigner: false, isWritable: true },
        { pubkey: WELL_KNOWN.systemProgram, isSigner: false, isWritable: false },
      ],
      data: encodeSetNftProgramId({ nftProgramId: PERCOLATOR_NFT_PROGRAM_ID }),
    });
    const m1Descriptor: TailTxDescriptor = {
      label: "Creating the market",
      instructions: [createSlabIx, createAtaIx, initMarketIx, setNftProgramIdIx],
      computeUnits: 400_000,
      signers: [slabKp],
    };

    // M2: createAccount(portfolio)+InitUser + createAccount(ctx)+SetMatcherConfig+InitMatcherCtx
    const createPortfolioIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: lpPortfolioKp.publicKey,
      lamports: portfolioRent, space: V17_PORTFOLIO_ACCOUNT_LEN, programId,
    });
    const initPortfolioIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, {
        owner: walletPk, market: slabPk, portfolio: lpPortfolioKp.publicKey,
      }),
      data: encodeInitUser({}),
    });
    const createCtxIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherCtxRent, space: MATCHER_CONTEXT_LEN, programId: matcherProgramId,
    });
    const setMatcherConfigIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, {
        lpOwner: walletPk, market: slabPk, lpPortfolio: lpPortfolioKp.publicKey,
        matcherProg: matcherProgramId, matcherCtx: matcherCtxKp.publicKey, matcherDelegate: matcherDelegatePk,
      }),
      // v18 fresh-market bootstrap: the LP is the FIRST portfolio created on this
      // brand-new market, so its program-assigned portfolioId is 1 and its
      // matcher-sequence is 0 (InitUser just ran in this same tx, no prior ops).
      // assetGenerationFrontier = header.next_market_id = max_market_slots + 1
      // (V17_MAX_PORTFOLIO_ASSETS + 1); tradeFeeCapBps 10000 = no practical LP cap;
      // expirySlot = born-immortal non-lapsing grant.
      data: encodeSetMatcherConfig({
        portfolioId: 1n,
        expectedSequence: 0n,
        assetGenerationFrontier: BigInt(V17_MAX_PORTFOLIO_ASSETS) + 1n,
        enabled: 1,
        tradeFeeCapBps: 10_000,
        expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT,
      }),
    });
    const initMatcherCtxIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
        lpOwner: walletPk, market: slabPk, lpPortfolio: lpPortfolioKp.publicKey,
        matcherCtx: matcherCtxKp.publicKey, matcherProg: matcherProgramId, matcherDelegate: matcherDelegatePk,
      }),
      data: encodeInitMatcherCtx({
        kind: 0, tradingFeeBps: Number(params.tradingFeeBps), baseSpreadBps: 50, maxTotalBps: 200,
        impactKBps: 0, liquidityNotionalE6: 0n,
        // LP GUARDRAILS (2026-07-27). These were i128::MAX / 0 — an unlimited,
        // fixed-price counterparty with no skew, which is how Jimothy's LP was
        // drained to $0 / -$2,479. Now sized to LP capital: see lib/market-params.ts.
        maxFillAbs: derived.maxFillAbs, maxInventoryAbs: derived.maxInventoryAbs,
        feeToInsuranceBps: 0, skewSpreadMultBps: derived.skewSpreadMultBps,
      }),
    });
    const m2Descriptor: TailTxDescriptor = {
      label: "Setting up the liquidity pool",
      instructions: [createPortfolioIx, initPortfolioIx, createCtxIx, setMatcherConfigIx, initMatcherCtxIx],
      computeUnits: 800_000,
      signers: [lpPortfolioKp, matcherCtxKp],
    };

    // Keeper mode inserts UpdateAssetAuthority(Oracle -> keeper) before M2/M3.
    // A fresh asset begins at authorityEpoch=0; that authority mutation
    // advances the shared asset authority-epoch CAS lane to 1.
    //
    // All CAS-bound transactions below are pre-signed before the delegation
    // lands, so they must encode the deterministic POST-delegation epoch.
    // Non-keeper launches do not mutate this lane here and remain at 0.
    const postCosignAuthorityEpoch = cosignTx ? 1n : 0n;

    // M3a: DepositCollateral + 2x TopUpBackingBucket (deadlock-prevention seed)
    const depositIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
        owner: walletPk, market: slabPk, portfolio: lpPortfolioKp.publicKey,
        sourceToken: userAta, vaultToken: vaultAta, tokenProgram: WELL_KNOWN.tokenProgram,
      }),
      // v18 fresh-market: LP portfolioId 1; matcher-sequence is now 1 because
      // SetMatcherConfig (M2, above) advanced it 0->1 (Deposit/Withdraw/SetMatcher
      // all bump the per-portfolio matcher-sequence).
      data: encodeDepositCollateral({
        portfolioId: 1n,
        expectedSequence: 1n,
        amount: params.lpCollateral.toString(),
      }),
    });
    const backingIxs: TransactionInstruction[] = [0, 1].map((domain) => {
      // v18 TOP_UP_BACKING_BUCKET grew to 7 accounts: +ledger (a per-domain,
      // handler-created PDA) +systemProgram (percolator-prog #433). The ledger is
      // DIFFERENT per domain, so derive it inside this per-domain map. Matches the
      // proven newmarkets.ts seed; the old 5-account array missed both new accounts.
      const [ledger] = deriveLpBackingLedger(programId, slabPk, domain);
      return buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_TOP_UP_BACKING_BUCKET, {
          signer: walletPk,
          market: slabPk,
          sourceToken: userAta,
          vaultToken: vaultAta,
          tokenProgram: WELL_KNOWN.tokenProgram,
          ledger,
          systemProgram: WELL_KNOWN.systemProgram,
        }),
        data: encodeTopUpBackingBucket({
          // Real seed, not dust: the SHORT domain can never be topped up again
          // once CreateLpVault runs. See backingSeedPerDomain in lib/market-params.ts.
          // v18 fresh-market: asset-0 market_id = 1; authority_epoch = 0 (fresh CAS);
          // intentId is the strictly-increasing one-shot lane — long(domain 0)=1,
          // short(domain 1)=2 (matches the newmarkets.ts seed).
          domain,
          marketId: 1n,
          intentId: BigInt(domain) + 1n,
          authorityEpoch: postCosignAuthorityEpoch,
          amount: backingSeed.toString(),
          expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT.toString(),
        }),
      });
    });
    const m3aDescriptor: TailTxDescriptor = {
      label: "Funding liquidity",
      instructions: [depositIx, ...backingIxs],
      computeUnits: 450_000,
      signers: [],
    };

    // M3b: TopUpInsurance + PermissionlessCrank — best-effort/non-fatal tail,
    // broadcast as its OWN transaction (never merged with M3a) so its failure
    // can never roll back the deposit above — preserves the H9/W3 fix.
    const topupIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, {
        signer: walletPk, market: slabPk, sourceToken: userAta, vaultToken: vaultAta, tokenProgram: WELL_KNOWN.tokenProgram,
      }),
      // v18 fresh-market: asset-0 market_id = 1; authority_epoch = 0; intentId is
      // the NEXT value on the shared insurance/backing one-shot lane — backing
      // consumed 1 and 2 above, so insurance takes 3.
      data: encodeTopUpInsurance({
        marketId: 1n,
        intentId: 3n,
        authorityEpoch: postCosignAuthorityEpoch,
        amount: params.insuranceAmount.toString(),
      }),
    });
    const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
      owner: walletPk, market: slabPk, portfolio: lpPortfolioKp.publicKey,
    });
    // ONLY a pyth market carries a Pyth push-oracle account on the crank.
    //
    // This used to be `!isAdminOracle && !isHyperpOracle`, which is TRUE for a
    // keeper market — and a keeper market's `oracleFeed` is the mainnet DEX POOL
    // address, not a Pyth hex feed id. So every keeper launch derived a
    // push-oracle PDA from a pool address and appended that garbage account to
    // its crank. Keeper markets are AUTH_MARK/admin-mode on chain with the
    // authority delegated to the crank wallet; they have no Pyth account at all.
    if (oracleMode === "pyth") {
      crankKeys.push({ pubkey: derivePythPushOraclePDA(params.oracleFeed)[0], isSigner: false, isWritable: false });
    }
    const crankIx = buildIx({
      programId, keys: crankKeys,
      // v18: PermissionlessCrank payload is { nowSlot, observations }.
      data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }),
    });
    const m3bDescriptor: TailTxDescriptor = {
      label: "Seeding the insurance fund",
      instructions: [topupIx, crankIx],
      computeUnits: 450_000,
      signers: [],
    };

    // M4a/M4b instructions — CreateLpVault (M4a) + createAccount(mint)+
    // createAccount(vault)+StakeInitPool tail (M4b). Split into two separate
    // transactions below (see the M4-split fix note above this function).
    const createLpVaultIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_CREATE_LP_VAULT, {
        admin: walletPk, market: slabPk, registry: lpVaultRegistry, lpMint: lpVaultMint,
        systemProgram: WELL_KNOWN.systemProgram, tokenProgram: WELL_KNOWN.tokenProgram,
      }),
      data: encodeCreateLpVaultV17({ feeShareBps: 1000, oiReservationThresholdBps: 8000, redemptionCooldownSlots: 5n, domain: 0 }),
    });
    const createLpMintIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: stakeLpMintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: WELL_KNOWN.tokenProgram,
    });
    const createStakeVaultIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: stakeVaultKp.publicKey,
      lamports: tokenAcctRent, space: ACCOUNT_SIZE, programId: WELL_KNOWN.tokenProgram,
    });
    const initPoolIx = buildIx({
      programId: stakeProgramId,
      keys: initPoolAccounts({
        admin: walletPk, slab: slabPk, pool: stakePoolPda, lpMint: stakeLpMintKp.publicKey,
        vault: stakeVaultKp.publicKey, vaultAuth: stakeVaultAuth, collateralMint: params.mint, percolatorProgram: programId,
      }),
      data: encodeStakeInitPool(5n, 0n),
    });
    // UpdateFeeSplit (wrapper tag 86) — creator-chosen split, MARKETAUTH-GATED, so it
    // MUST land BEFORE initPoolIx (StakeInitPool irreversibly rotates cfg.marketauth to
    // the pool PDA; after that this tag is only reachable via the stake CPI proxy).
    // Only emitted for a non-default split (defaults are written at InitMarket). Guarded
    // by the SAME rule the wrapper enforces so a bad split can never reach chain here.
    const feeSplitArgs = params.feeSplit;
    const updateFeeSplitIx = feeSplitArgs
      ? (() => {
          // v18 fresh-market: UpdateFeeSplit (tag 86) is CAS-bound to asset-0's
          // authority_epoch lane; on a brand-new market that lane is 0. This runs
          // BEFORE StakeInitPool rotates marketauth, so the creator is still the
          // gating authority.
          const feeSplitV18 = { ...feeSplitArgs, authorityEpoch: postCosignAuthorityEpoch };
          const reason = validateFeeSplit(feeSplitV18);
          if (reason) throw new Error(`Invalid fee split: ${reason}`);
          return buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_UPDATE_FEE_SPLIT, { admin: walletPk, market: slabPk }),
            data: encodeUpdateFeeSplit(feeSplitV18),
          });
        })()
      : null;
    // BindInsuranceAuthority (stake tag 19) — binds the vault_auth PDA as asset-0's
    // insurance_authority + insurance_operator (two CPIs to wrapper UpdateAssetAuthority).
    // REQUIRED, or the staker/insurance fee leg has no exit. Runs AFTER initPoolIx (the
    // pool PDA must exist), signed by the creator, who is still asset-0's insurance
    // authority (InitPool rotates marketauth, not insurance_authority).
    const bindInsuranceIx = buildIx({
      programId: stakeProgramId,
      keys: bindInsuranceAuthorityAccounts({
        admin: walletPk,
        poolPda: stakePoolPda,
        vaultAuth: stakeVaultAuth,
        slab: slabPk,
        percolatorProgram: programId,
      }),
      data: encodeStakeBindInsuranceAuthority(),
    });
    // BUG FIX (2026-09-25, tester-reported "Step 5 Create Earn vault — Internal
    // error"): M4 used to bundle CreateLpVault + createAccount(mint) +
    // createAccount(vault) + [UpdateFeeSplit] + StakeInitPool + BindInsuranceAuthority
    // into ONE transaction — up to 6 instructions, 3 signers (wallet + 2 fresh
    // keypairs) and ~18 unique accounts, by far the largest/most fragile tx in the
    // whole pipeline. The sequential per-step path (Step 4 / Step 5 below in the
    // resume/retry flow) has always kept these as TWO separate sends — CreateLpVault
    // alone, then the mint/vault/InitPool/Bind bundle — and that split is what makes
    // Step 4 there small and reliable. Mirror that split here: M4a is CreateLpVault
    // alone (matches STEP_LABELS[4] = "Creating Earn vault...", the exact step
    // testers reported failing); M4b is everything that must follow it. This also
    // gives each piece its own retryable landing step (lastStep 4→5→6) instead of
    // one opaque "5/6 bundled" failure that always blamed the Earn-vault label even
    // when the actual broadcast/size issue was in the (unrelated) stake-pool tail.
    const m4aDescriptor: TailTxDescriptor = {
      label: "Creating the Earn vault",
      instructions: [createLpVaultIx],
      computeUnits: 250_000,
      signers: [],
    };
    const m4bDescriptor: TailTxDescriptor = {
      label: "Opening the staking pool",
      // Order is load-bearing (see orderStakeTailInstructions): UpdateFeeSplit (if any)
      // BEFORE InitPool, Bind AFTER InitPool.
      instructions: orderStakeTailInstructions(
        [createLpMintIx, createStakeVaultIx],
        updateFeeSplitIx,
        initPoolIx,
        bindInsuranceIx,
      ),
      computeUnits: 900_000,
      signers: [stakeLpMintKp, stakeVaultKp],
    };

    // The 6 dependent, rebuild-capable txs — SAME order as before, with M4 now
    // split into M4a/M4b (see the fix note above). Building them here against the
    // one shared `blockhash` is byte-for-byte equivalent to the old inline
    // `buildBatchTx` calls; the descriptors are what let `recoverTailFrom` (below)
    // rebuild only the not-yet-landed ones against a fresh blockhash if the tail's
    // serial confirm-then-broadcast pipeline outruns this blockhash's validity.
    const tailDescriptors: TailTxDescriptor[] = [m1Descriptor, m2Descriptor, m3aDescriptor, m3bDescriptor, m4aDescriptor, m4bDescriptor];
    const buildTailTx = (d: TailTxDescriptor, hash: string): Transaction =>
      buildBatchTx({ instructions: d.instructions, computeUnits: d.computeUnits, priorityFeeMicroLamports: priorityFee, blockhash: hash, feePayer: walletPk });
    const [m1, m2, m3a, m3b, m4a, m4b] = tailDescriptors.map((d) => buildTailTx(d, blockhash));

    // cosignTx is deserialized exactly as the server built it — its own
    // blockhash, no heap-frame/CU ixs added — never run through buildBatchTx.
    // It is NOT a TailTxDescriptor and is never rebuilt on expiry (see the
    // TailTxDescriptor comment above).
    const orderedTxs: Transaction[] = [m1, ...(cosignTx ? [cosignTx] : []), m2, m3a, m3b, m4a, m4b];
    // Human-readable label per batched tx, in the SAME order — the progress UI
    // shows what is being CREATED ("Creating the market", "Funding liquidity"),
    // never internal transaction indices. A launching user cares about market
    // milestones, not our tx-packing scheme.
    const orderedLabels: string[] = [
      m1Descriptor.label,
      ...(cosignTx ? ["Connecting the price feed"] : []),
      m2Descriptor.label,
      m3aDescriptor.label,
      m3bDescriptor.label,
      m4aDescriptor.label,
      m4bDescriptor.label,
    ];

    // ---- ONE wallet approval for the whole batch --------------------------
    setState((s) => ({ ...s, phase: "awaiting-signature", stepLabel: "Approve the transaction batch in your wallet..." }));
    const signedTxs = await signAllCompat(wallet, orderedTxs);

    // ---- Partial-sign keypairs AFTER the wallet signs (Privy embedded
    //      wallets can strip unknown signatures added before their own
    //      signing flow runs — mirrors lib/tx.ts's sendTx ordering) --------
    let idx = 0;
    const signedM1 = signedTxs[idx++];
    const signedCosign = cosignTx ? signedTxs[idx++] : null;
    const signedM2 = signedTxs[idx++];
    const signedM3a = signedTxs[idx++];
    const signedM3b = signedTxs[idx++];
    const signedM4a = signedTxs[idx++];
    const signedM4b = signedTxs[idx++];
    if (!signedM1 || !signedM2 || !signedM3a || !signedM3b || !signedM4a || !signedM4b) {
      throw new Error("Wallet did not return a signature for every transaction in the batch.");
    }
    signedM1.partialSign(slabKp);
    signedM2.partialSign(lpPortfolioKp, matcherCtxKp);
    signedM4b.partialSign(stakeLpMintKp, stakeVaultKp);

    // ---- Mutable tail state for blockhash-expiry recovery -----------------
    // `signedTail[i]` is the CURRENTLY-SIGNED transaction for `tailDescriptors[i]`
    // — starts as the one-approval batch's own signatures; `recoverTailFrom`
    // below (defined after `landed`/`landingTotal`/`orderedLabels` exist, just
    // before the pipelined broadcast starts) overwrites entries in place if a
    // not-yet-landed one has to be rebuilt against a fresh blockhash.
    const signedTail: Transaction[] = [signedM1, signedM2, signedM3a, signedM3b, signedM4a, signedM4b];
    let blockhashRecoveries = 0;

    // ---- Persist recovery state BEFORE the first broadcast ---------------
    saveInFlightMarket({
      slabAddress: slabPk.toBase58(),
      slabSecretKey: Array.from(slabKp.secretKey),
      adminAddress: walletPk.toBase58(),
      collateralAta: vaultAta.toBase58(),
      collateralMint: params.mint.toBase58(),
      programId: programId.toBase58(),
      network: isDevnetEnv ? "devnet" : "mainnet",
      createdAt: Date.now(),
      lastStep: 0,
    });

    // ---- Pipelined broadcast ----------------------------------------------
    broadcastStarted = true;
    const landingTotal = orderedTxs.length;
    let landed = 0;
    const advanceLanding = (sig?: string) => {
      landed += 1;
      setState((s) => ({
        ...s,
        txSigs: sig ? [...s.txSigs, sig] : s.txSigs,
        phase: "landing",
        landingIndex: landed,
        landingTotal,
        landingLabels: orderedLabels,
        // Label the step now IN PROGRESS (the one after what just landed);
        // once everything has landed, show the finishing state.
        stepLabel: orderedLabels[landed] ?? "Finishing up",
      }));
    };
    setState((s) => ({
      ...s,
      phase: "landing",
      landingIndex: 0,
      landingTotal,
      landingLabels: orderedLabels,
      stepLabel: orderedLabels[0],
    }));

    /**
     * Rebuild + re-sign `tailDescriptors[startIdx..]` (the not-yet-landed
     * remainder of the tail) against a fresh blockhash, in ONE additional
     * wallet approval, and write the results back into `signedTail`.
     * Preserves the exact partial-sign ordering the happy path uses (wallet
     * signs first, then keypairs — see the partial-sign comment above).
     */
    const recoverTailFrom = async (startIdx: number): Promise<void> => {
      // GH#2623: the direct gate against the "keeps popping up after
      // navigating away" complaint — this is the ONLY place in the batched
      // fast path that prompts a fresh wallet signature outside the user's
      // own initiating click. Checked before anything else so an aborted
      // caller never sees another popup, and before blockhashRecoveries is
      // incremented so an aborted attempt doesn't spend the recovery budget.
      if (abortSignal?.aborted) {
        throw new TxCancelledError("Market creation cancelled — you navigated away before this step finished.");
      }
      blockhashRecoveries += 1;
      setState((s) => ({
        ...s,
        phase: "awaiting-signature",
        stepLabel: "Blockhash expired — refreshing and re-approving the remaining steps...",
      }));
      const freshBlockhash = await getFreshBlockhash(connection, true);
      const rebuiltDescriptors = tailDescriptors.slice(startIdx);
      const rebuiltTxs = rebuiltDescriptors.map((d) => buildTailTx(d, freshBlockhash));
      const resigned = await signAllCompat(wallet, rebuiltTxs);
      for (let j = 0; j < rebuiltDescriptors.length; j++) {
        const descriptor = rebuiltDescriptors[j];
        const tx = resigned[j];
        if (!descriptor || !tx) {
          throw new Error("Wallet did not return a signature for every transaction in the blockhash-recovery batch.");
        }
        if (descriptor.signers.length > 0) tx.partialSign(...descriptor.signers);
        signedTail[startIdx + j] = tx;
      }
      setState((s) => ({
        ...s,
        phase: "landing",
        landingTotal,
        landingLabels: orderedLabels,
        stepLabel: orderedLabels[landed] ?? "Finishing up",
      }));
    };

    /**
     * Broadcast `signedTail[idx]` (one of M1/M2/M3a/M3b/M4), recovering ONCE
     * per expiry (capped at `MAX_BLOCKHASH_RECOVERIES` total) if it fails
     * with a blockhash-expiry error — never re-broadcasts a stale signed tx;
     * `recoverTailFrom` always produces a fresh one first. Any other error
     * (or expiry past the cap) rethrows unchanged, so the existing
     * fatal/non-fatal handling around each call site is untouched.
     */
    const broadcastTailTx = async (idx: number): Promise<string> => {
      for (;;) {
        try {
          const tx = signedTail[idx];
          if (!tx) throw new Error(`Missing signed transaction for tail step ${idx}.`);
          return await broadcastSignedTx(connection, tx);
        } catch (err) {
          const canRecover = blockhashRecoveries < MAX_BLOCKHASH_RECOVERIES;

          // Case A — the SEND was rejected as expired (no signature exists, the
          // tx never landed): safe to rebuild against a fresh blockhash.
          if (isBlockhashExpiredError(err) && canRecover) {
            console.warn(
              `[useCreateMarket] batch: blockhash expired at tail step ${idx} — recovering (attempt ${blockhashRecoveries + 1}/${MAX_BLOCKHASH_RECOVERIES})`,
            );
            await recoverTailFrom(idx);
            continue; // retry the SAME step with the freshly rebuilt+signed tx
          }

          // Case B — the tx was SUBMITTED but confirmation timed out at the edge
          // of the blockhash window; it may still have landed. Status-check the
          // signature FIRST (mirrors sendTx's R2-S7 landing check) — only rebuild
          // if it is DEFINITIVELY absent. On "landed" treat as success; on any
          // indeterminate result (RPC error, on-chain failure, processed-not-
          // confirmed) propagate rather than risk re-running a landed createAccount.
          if (isConfirmationTimeoutError(err)) {
            // The landing-check is free (one RPC read) and ALWAYS safe, so it
            // runs regardless of the recovery budget — a tx that already landed
            // must be reported as success even after the rebuild cap is spent,
            // otherwise a fully-successful launch gets reported as a failure.
            // Only the REBUILD leg is gated on `canRecover`.
            const sig = (err as { signature?: string }).signature;
            const landed = sig ? await checkSignatureLanded(connection, sig) : "unknown";
            if (landed === "landed" && sig) {
              console.warn(
                `[useCreateMarket] batch: tail step ${idx} confirmation timed out but the tx DID land — continuing`,
              );
              return sig; // it's on-chain; treat exactly like a normal success
            }
            if (landed === "not-found" && canRecover) {
              console.warn(
                `[useCreateMarket] batch: tail step ${idx} timed out and did not land — recovering (attempt ${blockhashRecoveries + 1}/${MAX_BLOCKHASH_RECOVERIES})`,
              );
              await recoverTailFrom(idx);
              continue;
            }
            // "unknown" (indeterminate — never rebuild), or "not-found" with the
            // recovery budget exhausted → fall through and propagate (resumable).
          }
          throw err;
        }
      }
    };

    const m1Sig = await broadcastTailTx(0);

    // M1 always completes sequential Step 0. For a keeper launch, Step 1
    // is NOT complete until the keeper co-sign/delegation below lands.
    // Keep React state and the persisted recovery cursor synchronized.
    const afterM1Step = signedCosign ? 1 : 2;
    setState((s) => ({
      ...s,
      slabAddress: slabPk.toBase58(),
      step: afterM1Step,
    }));
    advanceLanding(m1Sig);
    updateInFlightStep(slabPk.toBase58(), afterM1Step);

    // ZOMBIE-MARKET FIX (2026-07-27): this POST is what makes a market VISIBLE
    // in the app. It used to fire here, immediately after M1, in parallel with
    // the funding steps — so a launch that died at M3a (which is exactly what
    // happened to ANSEM: slab + LP portfolio created, deposit never landed,
    // steps 4-5 never ran) still published a listed, unfunded, untradeable
    // market. Because "create the market" is always step 1 and always succeeds,
    // EVERY failed launch left one behind.
    //
    // Now it is deferred: `registerMarketInDb()` is called only after M3a
    // (DepositCollateral + backing seed) has landed, so a market becomes
    // visible only once it actually holds collateral. A launch that dies before
    // then leaves an on-chain slab nobody sees, instead of a broken listing.
    //
    // keeper-register is NOT deferred — it must still run before M4, because
    // StakeInitPool rotates marketauth and keeper-register's H1 check requires
    // marketauth to still equal the deployer.
    // POST /api/markets is gone: keeper-register now writes the markets row
    // itself, so a launch makes ONE registration call.
    //
    // It had to go, not just move. It 409s when a row already exists
    // ("metadata is immutable via this endpoint") and this call site swallowed
    // that as non-fatal, while the indexer inserts a row for any slab it
    // discovers within ~60s. The slab exists before this ran, so the indexer
    // usually won: measured 2026-07-30, all 5 rows on the live DB were
    // metadata_source='auto' and this endpoint had never once created one.
    // Registration now happens under the marketauth proof, which can safely
    // overwrite an 'auto' row. See lib/market-registration.ts.
    if (signedCosign) {
      const cosignSig = await broadcastSignedTx(connection, signedCosign);
      advanceLanding(cosignSig);

      // Keeper delegation is the remaining work in sequential Step 1.
      // Only after it lands may recovery skip Step 1.
      setState((s) => ({ ...s, step: 2 }));
      updateInFlightStep(slabPk.toBase58(), 2);
    }

    const m2Sig = await broadcastTailTx(1);
    advanceLanding(m2Sig);

    // M2 completes LP portfolio + matcher setup. If M3a fails, both the
    // visible Retry button and persisted recovery must resume at Step 3.
    setState((s) => ({ ...s, step: 3 }));
    updateInFlightStep(slabPk.toBase58(), 3);

    const m3aSig = await broadcastTailTx(2);
    advanceLanding(m3aSig);

    // The market now holds collateral and both backing domains are seeded, so
    // it is safe to publish. Fired without awaiting — a slow DB write must not
    // delay M3b/M4, and it is awaited once at the end of the tail.

    // REGISTRATION — deliberately pinned to this window, between M3a and M4.
    //
    // It used to be created before M2, which was safe while it only wrote the
    // keeper's blob. It now writes the `markets` row, and that row is what
    // LISTS the market. Firing it earlier would republish the zombie bug this
    // ordering exists to prevent: registration used to fire right after M1, so
    // any launch that died later still published a listed, unfunded,
    // untradeable market (that is what happened to the ANSEM market).
    //
    // It also cannot move any LATER: M4's StakeInitPool rotates marketauth away
    // from the deployer, and keeper-register's H1 check requires marketauth to
    // still equal the deployer. After M3a and before M4 is the only window that
    // satisfies both constraints.
    // #2464: this used to be STARTED here and awaited after the insurance check,
    // so the registration request was already in flight — and could already have
    // completed — while that check was still deciding whether the launch had
    // failed. A launch that threw on an unseeded insurance fund could therefore
    // leave the market listed and keeper-registered anyway.
    //
    // It is now a THUNK, invoked below only once insurance has verified. The
    // window it must run in is unchanged and still satisfied: after M3a (so a
    // market is only listed once it holds collateral) and before M4 (whose
    // StakeInitPool rotates marketauth away from the deployer, which
    // keeper-register's H1 check requires).
    //
    // The cost is latency: the round-trip no longer overlaps M3b's broadcast, so
    // the tail sits a little longer against the shared blockhash. That is the
    // right trade — the blockhash-expiry path already REBUILDS a not-yet-landed
    // tail tx (see TailTxDescriptor), whereas an incorrectly published market has
    // no equivalent undo.
    const startKeeperRegister = (): Promise<KeeperRegisterOutcome> =>
      (isKeeperOracle && params.dexPoolAddress && keeperProofSignature)
        ? registerMarketWithKeeper(
            { publicKey: walletPk, signMessage: wallet.signMessage },
            {
              slabAddress: slabPk.toBase58(),
              mainnetCA: params.mainnetCA,
              dexPoolAddress: params.dexPoolAddress,
              dexType: params.dexType,
              symbol: params.symbol,
              payload: (() => {
                const built = buildMarketRegistrationPayload({
                  slabAddress: slabPk.toBase58(),
                  params,
                  deployer: walletPk.toBase58(),
                  oracleMode,
                  isAdminOracle,
                  isDevnetEnv,
                });
                // Keep it for Retry — see launchRegistrationPayloads.
                launchRegistrationPayloads.set(slabPk.toBase58(), built);
                return built;
              })(),
            },
            { deployer: walletPk.toBase58(), signature: keeperProofSignature },
          )
        : Promise.resolve<KeeperRegisterOutcome>({ registered: false, message: "" });

    // M3b carries the insurance seed, which is NOT optional: it is the layer
    // that absorbs losses before the LP does. This used to swallow every
    // failure, so a market could come up with insurance = 0 and nothing said so.
    //
    // Assert the OUTCOME rather than the transaction result. M3b bundles
    // TopUpInsurance with a best-effort PermissionlessCrank, so a crank revert
    // rolls the deposit back even though the deposit itself was fine — and a
    // skipped build (see the idempotency check in the sequential path) produces
    // no error at all. Reading the engine's own insuranceBalance afterwards
    // catches all three: never built, reverted, and partially applied.
    let m3bError: unknown = null;
    try {
      const m3bSig = await broadcastTailTx(3);
      advanceLanding(m3bSig);
    } catch (err) {
      m3bError = err;
      advanceLanding(undefined);
    }

    if (params.insuranceAmount > 0n) {
      let insuranceOnChain = 0n;
      try {
        const slabInfo = await connection.getAccountInfo(slabPk);
        if (slabInfo?.data) {
          insuranceOnChain = parseMarketGroupV17OI(new Uint8Array(slabInfo.data)).insuranceBalance;
        }
      } catch {
        // Fall through — an unverifiable seed is treated as a failed one.
      }
      if (insuranceOnChain < params.insuranceAmount) {
        throw new Error(
          `Insurance fund was not seeded (on-chain ${insuranceOnChain} < requested ${params.insuranceAmount}). ` +
            "The market exists and is funded — retry this step to seed it." +
            (m3bError ? ` Cause: ${m3bError instanceof Error ? m3bError.message : String(m3bError)}` : ""),
        );
      }
    } else if (m3bError) {
      // No insurance requested — the crank alone stays best-effort.
      console.warn("[useCreateMarket] batch: post-LP crank failed (non-fatal):", m3bError);
    }
    setState((s) => ({ ...s, step: 4 }));
    updateInFlightStep(slabPk.toBase58(), 4);

    // #2464: started HERE, not above — everything that can fail the launch has
    // now run, so no externally visible registration happens for a launch that is
    // about to be reported as failed.
    const keeperOutcome = await startKeeperRegister();

    // M4a: CreateLpVault alone (see the M4-split fix note above the descriptor
    // definitions) — this is the "Creating Earn vault..." step (STEP_LABELS[4]).
    // Landing it as its OWN transaction, separately from the stake-pool tail,
    // means a failure here is reported (and resumable) as exactly what it is,
    // and never drags in the much larger/riskier M4b bundle.
    const m4aSig = await broadcastTailTx(4);
    advanceLanding(m4aSig);
    setState((s) => ({ ...s, step: 5 }));
    updateInFlightStep(slabPk.toBase58(), 5);

    // M4b: mint/vault creation + [UpdateFeeSplit] + StakeInitPool + BindInsuranceAuthority.
    // MUST run after M4a (CreateLpVault is marketauth-gated; StakeInitPool here
    // irreversibly rotates marketauth to the pool PDA) and after keeper-register
    // above (same marketauth-rotation constraint that used to gate the old
    // single M4).
    const m4bSig = await broadcastTailTx(5);
    advanceLanding(m4bSig);
    updateInFlightStep(slabPk.toBase58(), 6);


    // #2608/#2610: this used to fire a background POST /api/devnet-airdrop here,
    // duplicating the claim the "GET SIM-USDC & TRADE" button on the success
    // screen already makes on click (LaunchSuccess.tsx's handleMintAndTrade) —
    // every failure mode of that duplicate call (500, 429, network error) put an
    // unreportable error banner or a permanently-stuck spinner on the most
    // important screen in the product. Removed: the button beside it does the
    // identical job, and the creator clicks it to reach the trade page anyway,
    // so nothing is lost. Still set devnetMint synchronously so that button renders.
    if (isDevnetEnv) {
      setState((s) => ({ ...s, devnetMint: params.mint.toBase58() }));
    }

    clearInFlightMarket(slabPk.toBase58());
    setState((s) => ({
      ...s,
      loading: false,
      step: 6,
      phase: "done",
      stepLabel: "Market created!",
      keeperDelegated: keeperOutcome.registered,
      keeperMessage: keeperOutcome.message || s.keeperMessage,
      slabAddress: slabPk.toBase58(),
    }));

    return { status: "success" };
  } catch (err) {
    if (!broadcastStarted) {
      // Nothing landed — safe to fall back to the sequential path in the
      // SAME create() call. See the FALLBACK CONTRACT note above.
      //
      // Carry the reason out. The fallback is silent BY DESIGN for the user's
      // funds (nothing broadcast, the launch still completes) but it was also
      // silent for diagnosis, which is a different thing and not a feature:
      // the batch has several unrelated ways to throw before broadcast — a
      // 429 from /api/devnet-pre-fund's 24h faucet gate, a keeper co-sign
      // failure, an airdrop that did not confirm — and they are
      // indistinguishable from the outside.
      const reason = describeBatchFallback(err);
      console.warn(
        `[useCreateMarket] BATCHED launch fell back to the 6-step sequential path: ${reason}`,
      );
      return { status: "fallback", reason };
    }
    // GH#2623: distinct from a real failure — the launch was abandoned (the
    // wizard unmounted), not rejected or errored. parseMarketCreationError's
    // "User rejected"/"Transaction cancelled" branch reads as a wallet
    // decline and tells the user to click Retry; that is the wrong message
    // for a page they already left. "fatal" is still the right STATUS (never
    // fall back to the sequential path here — something is already
    // broadcast; resuming goes through RecoverSolBanner like any other
    // abandoned launch), just with an accurate reason.
    const msg = isTxCancelledError(err)
      ? "Market creation cancelled — navigated away before it finished."
      : parseMarketCreationError(err);
    setState((s) => ({ ...s, loading: false, error: msg }));
    return { status: "fatal" };
  }
}

const STEP_LABELS = [
  "Creating slab & initializing market...",
  "Oracle setup & pre-LP crank...",
  "Initializing LP...",
  "Depositing collateral, insurance & final crank...",
  "Creating Earn vault...",
  "Initializing stake pool (finalizing market)...",
];

export function useCreateMarket() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [state, setState] = useState<CreateMarketState>({
    step: 0,
    stepLabel: "",
    txSigs: [],
    slabAddress: null,
    error: null,
    loading: false,
    devnetMint: null,
    insuranceMintFailed: false,
    backingSeedFailed: false,
    keeperDelegated: false,
    keeperMessage: null,
    keeperRegistering: false,
    phase: "idle",
    landingIndex: 0,
    landingTotal: 0,
    batchFallbackReason: null,
  });

  // PERC-8329 / GH#1964: Slab keypair is normally kept in-memory ONLY (this ref), not
  // localStorage — persisting a secret key there is unsafe in general (any same-origin
  // script, including browser extensions, can read it).
  //
  // BUG 7 fix (2026-07-06): that policy is INTENTIONALLY superseded for the in-flight
  // recovery flow — saveInFlightMarket() (called from Step 0 below) DOES persist
  // slabSecretKey to localStorage specifically so the ReclaimSlabRent / resume-creation
  // path still works after a tab close (see lib/inFlightMarket.ts's header for the
  // accepted trade-off). Nothing previously read that persisted secret back into this
  // ref on mount, so a page refresh mid-flow always hit "Cannot retry: slab keypair
  // lost" even though the secret was sitting in localStorage the whole time. The effect
  // below hydrates it; restoreSlabKeypair lets RecoverSolBanner's onResume hand the
  // keypair back in explicitly (belt-and-suspenders for the same-session resume path).
  const slabKpRef = useRef<Keypair | null>(null);

  /**
   * GH#2623: a fresh controller per `create()` call — never re-abort a
   * previous, already-finished launch's controller, and never leave a NEW
   * launch permanently aborted because an earlier one was cancelled. See
   * `cancelInFlightLaunch` (below) and CreateMarketWizard's unmount cleanup,
   * the only current caller: leaving `/create` mid-launch must stop the
   * wallet-popup retry loop (see `sendTx`'s and `recoverTailFrom`'s abort
   * checks in lib/tx.ts / above) instead of it continuing on a page the user
   * is no longer looking at.
   */
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelInFlightLaunch = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (slabKpRef.current) return; // already have a keypair this session — don't clobber it
    if (!wallet.publicKey) return; // wait for wallet connection so we can verify ownership
    const inFlight = loadLastInFlightMarket();
    if (!inFlight) return;
    // Wallet-match gate mirrors useStuckSlabs' security check — never attach another
    // wallet's persisted slab secret to this session.
    if (inFlight.adminAddress !== wallet.publicKey.toBase58()) return;
    if (!inFlight.slabSecretKey || inFlight.slabSecretKey.length !== 64) return;
    try {
      const kp = Keypair.fromSecretKey(Uint8Array.from(inFlight.slabSecretKey));
      slabKpRef.current = kp;
      setState((s) => (s.slabAddress ? s : { ...s, slabAddress: inFlight.slabAddress }));
    } catch (err) {
      console.warn("[useCreateMarket] Failed to hydrate slab keypair from in-flight state:", err);
    }
  }, [wallet.publicKey]);

  /**
   * BUG 7 fix: explicit hydration entry point for the "Resume Creation" / "Retry
   * Initialization" flow. RecoverSolBanner's onResume callback only forwards
   * (slabAddress, fromStep), so the caller (CreateMarketWizard) independently calls
   * useStuckSlabs() to get the already-reconstructed Keypair and hands it here — belt-
   * and-suspenders alongside the mount effect above (which could race a fresh wallet
   * connection on the same render).
   */
  const restoreSlabKeypair = useCallback((keypair: Keypair, slabAddress: string) => {
    slabKpRef.current = keypair;
    setState((s) => ({ ...s, slabAddress }));
  }, []);

  const create = useCallback(
    async (params: CreateMarketParams, retryFromStep?: number) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState((s) => ({ ...s, error: "Wallet not connected" }));
        return;
      }

      // GH#2623: a fresh controller for THIS call. Threaded into every
      // wallet-signing primitive below (attemptFreshBatchedLaunch's
      // recoverTailFrom, and every sequential sendTx call) so
      // cancelInFlightLaunch() — called on CreateMarketWizard unmount — stops
      // any FUTURE signing prompt without touching a step already broadcast.
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const abortSignal = abortController.signal;

      // Every risk parameter for this market, derived from the creator's
      // leverage and LP seed (see lib/market-params.ts). Shared by the
      // sequential path's InitMarket + InitMatcherCtx sites below, exactly as
      // the merged path derives its own copy.
      const derived = deriveMarketParams(
        params.initialMarginBps > 0 ? 10_000 / params.initialMarginBps : MIN_LEVERAGE_X,
        params.lpCollateral,
        params.initialPriceE6,
      );
      const backingSeed = backingSeedPerDomain(params.lpCollateral);

      // Select program based on slab tier — each MAX_ACCOUNTS variant is a separate deployment
      const cfg = getConfig();
      // PERC-277: Default to 4096 (large) — the main devnet program binary is compiled for
      // MAX_ACCOUNTS=4096. Using a smaller tier against a 4096-account program causes
      // InvalidSlabLen (error 0x4) because the program's hardcoded SLAB_LEN won't match.
      type SlabTier = "small" | "medium" | "large";
      const tierMap: Record<number, SlabTier> = { 256: "small", 1024: "medium", 4096: "large" };
      const tierKey: SlabTier = tierMap[params.maxAccounts ?? 4096] ?? "large";
      const selectedProgramId = cfg.programsBySlabTier?.[tierKey] ?? cfg.programId;
      const programId = new PublicKey(selectedProgramId);
      // PERC-470: Oracle mode detection
      // - "pyth": index_feed_id = pyth hex, uses KeeperCrank with Pyth PDA
      // - "hyperp": index_feed_id = zeros, uses UpdateHyperpMark (reads DEX pool directly)
      // - "admin": index_feed_id = zeros, uses PushOraclePrice + KeeperCrank
      // PERC-devnet: detect the runtime network instead of inferring it from
      // params.mainnetCA. mainnetCA identifies mirrored-token metadata and is
      // populated for mainnet market creation as well.
      const network = getNetwork();
      const isDevnetEnv = network === "devnet";

      const resolvedOracleMode =
        params.oracleMode ??
        (params.oracleFeed === ALL_ZEROS_FEED ? "admin" : "pyth");

      // Hyperp reads live DEX pool accounts on-chain. Mainnet pool accounts are
      // unavailable for devnet mirrors, so only that exact combination falls
      // back to Admin. Mainnet Hyperp must remain Hyperp.
      const oracleMode = resolveMarketOracleMode({
        requestedMode: resolvedOracleMode,
        network,
        hasMainnetCA: !!params.mainnetCA,
      });

      const isAdminOracle = oracleMode === "admin";
      const isHyperpOracle = oracleMode === "hyperp";
      const isKeeperOracle = oracleMode === "keeper";

      // PERC-470: Resolve DEX pool vault addresses for hyperp mode
      // If vaults weren't provided, fetch the pool account on-chain
      if (isHyperpOracle && params.dexPoolAddress && !params.dexBaseVault) {
        try {
          const poolPk = new PublicKey(params.dexPoolAddress);
          const poolAccount = await connection.getAccountInfo(poolPk);
          if (poolAccount?.data) {
            const dexType = detectDexType(poolAccount.owner);
            if (dexType) {
              const poolInfo = parseDexPool(dexType, poolPk, poolAccount.data);
              if (poolInfo.baseVault) params.dexBaseVault = poolInfo.baseVault.toBase58();
              if (poolInfo.quoteVault) params.dexQuoteVault = poolInfo.quoteVault.toBase58();
            }
          }
        } catch (e) {
          console.warn("PERC-470: Failed to resolve DEX pool vaults:", e);
        }
      }

      const startStep = retryFromStep ?? 0;
      if (retryFromStep !== undefined) {
        // Diagnosis breadcrumb (see signAllCompat's counterpart): resume and
        // retry flows use the sequential per-step path BY DESIGN — if a user
        // reports many signature prompts and this line is in their console,
        // they were resuming a stuck launch, not missing the batch path.
        console.info(`[useCreateMarket] resume/retry from step ${retryFromStep} — sequential flow by design`);
      }

      setState((s) => ({
        ...s,
        loading: true,
        error: null,
        step: startStep,
        stepLabel: STEP_LABELS[startStep],
        // Cleared on EVERY attempt, including retries. This is a spread, so a
        // reason left by an earlier fallback would otherwise survive into a
        // retry that never attempted the batch at all — and be rendered under
        // it, explaining a decision this attempt never made.
        batchFallbackReason: null,
        ...(startStep === 0 ? { txSigs: [], slabAddress: null } : {}),
      }));

      // PERC-8329: Slab keypair lives in memory only — no localStorage persistence.
      // Retries within the same session reuse slabKpRef.current. Page refresh requires restart.
      let slabKp: Keypair;
      let slabPk: PublicKey;
      let vaultAta: PublicKey;

      if (startStep === 0) {
        // W5 fix (2026-07-08): RecoverSolBanner's "RETRY INITIALIZATION" button calls
        // onResume(stuckSlabAddress, 0) after CreateMarketWizard already handed us the
        // STUCK slab's reconstructed keypair via restoreSlabKeypair() (populating
        // slabKpRef.current). Unconditionally generating a fresh keypair here — as this
        // branch used to do — ignored that and created a brand-new slab account,
        // orphaning the original stuck one (and its already-paid rent) instead of
        // retrying InitMarket on it. Only reuse the ref when retryFromStep is EXPLICITLY
        // 0 (a real retry/resume click) — not merely when it's undefined (a genuine
        // brand-new "Launch Market" click), where slabKpRef.current could still be
        // hydrated from a stale in-flight entry the user hasn't discarded yet (see the
        // mount effect above).
        if (retryFromStep === 0 && slabKpRef.current) {
          slabKp = slabKpRef.current;
          slabPk = slabKp.publicKey;
        } else {
          slabKp = Keypair.generate();
          slabKpRef.current = slabKp;
          slabPk = slabKp.publicKey;
        }
        // PERC-8329: Do NOT persist secret key to localStorage — keep in memory only.
        // If the user refreshes before completing all steps, they must start over.
      } else if (slabKpRef.current) {
        // Retry with persisted keypair — full functionality
        slabKp = slabKpRef.current;
        slabPk = slabKp.publicKey;
      } else if (state.slabAddress) {
        // Keypair lost (page refresh) but we have the address — limited retry (steps > 0 only)
        slabPk = new PublicKey(state.slabAddress);
        slabKp = null as unknown as Keypair;
      } else {
        setState((s) => ({
          ...s,
          loading: false,
          error: "Cannot retry: slab keypair lost. Please start over.",
        }));
        return;
      }

      let [vaultPda] = deriveVaultAuthority(programId, slabPk);

      // v17: PushOraclePrice (tag 16) and SetOracleAuthority (tag 17) do not exist.
      // For devnet bring-up, the v17 program is always assumed — detect lazily per-step
      // if needed. Setting isLegacyOracle = false skips all removed oracle instructions.
      // TODO: When v12 legacy support is needed, detect from on-chain magic bytes (like Step 1 does).
      const isLegacyOracle = false;

      // Fresh-launch batching fast path (2026-07-12): only a genuine "LAUNCH
      // MARKET" click (retryFromStep === undefined, which is exactly the
      // branch above that generated a brand-new slabKp) attempts this —
      // every resume/retry call passes an explicit step number and always
      // uses the sequential per-step code below unchanged. See
      // `attemptFreshBatchedLaunch`'s header comment for the full contract.
      if (retryFromStep === undefined && wallet.publicKey) {
        console.info("[useCreateMarket] fresh launch — attempting BATCHED flow (one approval)");
        const batchWalletPk = wallet.publicKey;
        const outcome = await attemptFreshBatchedLaunch({
          connection,
          wallet: {
            publicKey: batchWalletPk,
            signTransaction: wallet.signTransaction,
            signAllTransactions: wallet.signAllTransactions,
            signMessage: wallet.signMessage,
          },
          programId,
          slabKp,
          params,
          isDevnetEnv,
          isKeeperOracle,
          isAdminOracle,
          isHyperpOracle,
          oracleMode,
          setState,
          abortSignal,
        });
        if (outcome.status === "success") {
          slabKpRef.current = null;
          return;
        }
        if (outcome.status === "fatal") {
          // state.error already set inside attemptFreshBatchedLaunch — do
          // NOT fall through to the sequential path (something already
          // broadcast; resuming happens via the existing RecoverSolBanner /
          // handleRetry flow, which passes an explicit step and therefore
          // uses the sequential code below on its own next call).
          return;
        }
        // status === "fallback" — nothing broadcast; safe to run the
        // sequential path below in this SAME call. Reset the phase/landing
        // UI state so LaunchProgress falls back to its per-step rendering.
        // Keep the reason in state, not only in the console — the people who
        // hit this are launching a market, not watching devtools.
        //
        // This is React state and dies with the tab. It does NOT reach the
        // downloaded recovery JSON, which is built from the localStorage
        // in-flight record (RecoveryExportButton -> loadLastInFlightMarket)
        // and never sees CreateMarketState. The fallback happens before
        // anything is on chain, so there is no in-flight record to attach to
        // yet. Noted rather than implied.
        //
        // NOT surfaced as `error`: nothing failed from the user's point of
        // view. The launch continues, just with six prompts instead of one.
        setState((s) => ({
          ...s,
          phase: "idle",
          landingIndex: 0,
          landingTotal: 0,
          error: null,
          batchFallbackReason: outcome.reason,
        }));
      }

      try {
        // Step 0: Create slab + vault ATA + InitMarket (ATOMIC — all-or-nothing)
        // Merged into a single transaction to prevent SOL lock if InitMarket fails.
        // If any instruction fails, the entire tx rolls back — no stuck lamports.
        if (startStep <= 0) {
          setState((s) => ({ ...s, step: 0, stepLabel: STEP_LABELS[0] }));

          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);

          // Persist recovery state BEFORE sending TX0. Survives tab close so
          // the user can recover via the in-UI ReclaimSlabRent path or the
          // close-market-reclaim-all.ts script even if the browser dies.
          // 2026-05-12: PERC-8329 superseded for this flow — slab secret IS
          // persisted so the uninitialised-slab reclaim works. See
          // lib/inFlightMarket.ts header for trade-off rationale.
          saveInFlightMarket({
            slabAddress: slabPk.toBase58(),
            slabSecretKey: Array.from(slabKp.secretKey),
            adminAddress: wallet.publicKey.toBase58(),
            collateralAta: vaultAta.toBase58(),
            collateralMint: params.mint.toBase58(),
            programId: programId.toBase58(),
            network: isDevnetEnv ? "devnet" : "mainnet",
            createdAt: Date.now(),
            lastStep: 0,
          });

          // Check if slab account already exists (previous attempt may have landed)
          // PERC-1094 fix: also regenerate if the existing slab has the wrong size (stale
          // orphan from old SDK — e.g. 65352-byte account created before ENGINE_OFF fix).
          // Without this check, retries always call InitMarket on the wrong-sized slab and
          // fail with InvalidSlabLen (error 0x4) even after the SDK size was corrected.
          const expectedSlabSize = params.slabDataSize ?? DEFAULT_SLAB_SIZE;
          let existingAccount = await connection.getAccountInfo(slabKp.publicKey);
          if (existingAccount && existingAccount.data.length !== expectedSlabSize) {
            console.warn(
              `[useCreateMarket] PERC-1094: stale slab ${slabKp.publicKey.toBase58()} ` +
              `(${existingAccount.data.length}B, expected ${expectedSlabSize}B). ` +
              `Abandoning orphan and generating fresh keypair.`,
            );
            // PERC-8329: No localStorage cleanup needed — key was never stored there.
            slabKp = Keypair.generate();
            slabKpRef.current = slabKp;
            slabPk = slabKp.publicKey;
            // Recompute PDA and ATA for new slab keypair
            [vaultPda] = deriveVaultAuthority(programId, slabPk);
            vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
            existingAccount = null; // treat as fresh creation
          }
          if (existingAccount) {
            // Slab already created — check if market is initialized via v17 or v12 magic.
            // isV17Account handles the v17 magic; v12 parseHeader handles the PERCOLAT magic.
            let isInitialized: boolean;
            try {
              const existingData = new Uint8Array(existingAccount.data);
              if (isV17Account(existingData)) {
                isInitialized = true;
              } else {
                parseHeader(existingAccount.data);
                isInitialized = true;
              }
            } catch {
              isInitialized = false;
            }

            if (isInitialized) {
              // Market already initialized — skip to step 1
              setState((s) => ({
                ...s,
                txSigs: [...s.txSigs, "skipped-already-initialized"],
                slabAddress: slabKp.publicKey.toBase58(),
              }));
            } else {
              // Slab exists but NOT initialized — this is the stuck state we want to prevent.
              // Since we have the keypair, we can't close it (program-owned), but we can
              // try InitMarket on it. Create vault ATA (idempotent) + InitMarket.
              const createAtaIx = createAssociatedTokenAccountInstruction(
                wallet.publicKey, vaultAta, vaultPda, params.mint,
              );

              // W11 fix (2026-07-08): this used to require + transfer MIN_INIT_MARKET_SEED
              // (500 tokens) into the vault before InitMarket, auto-funding via
              // /api/devnet-pre-fund if short. launch-test-market.ts (the proven 8/8
              // on-chain reference) creates the vault ATA and calls InitMarket directly —
              // no seed transfer — and it succeeds with a zero vault balance; the engine
              // never accounts for or requires this deposit. Removing it drops an
              // unnecessary token requirement (and a devnet-pre-fund round-trip) from the
              // very first step of every market creation / recovery attempt.
              // Margin and the price-move budget share one derivation — see
              // lib/market-params.ts.
              const initialMarginBps = BigInt(derived.initialMarginBps);
              const v17InitArgs: InitMarketV17Args = {
                maxPortfolioAssets: V17_MAX_PORTFOLIO_ASSETS,
                hMin: "1000",
                hMax: "100000",
                initialPrice: params.initialPriceE6.toString(),
                minNonzeroMmReq: "1000000",
                minNonzeroImReq: "2000000",
                maintenanceMarginBps: String(derived.maintenanceMarginBps),
                initialMarginBps: initialMarginBps.toString(),
                maxTradingFeeBps: BigInt(params.tradingFeeBps).toString(),
                tradeFeeBaseBps: BigInt(params.tradingFeeBps).toString(),
                liquidationFeeBps: "50",
                liquidationFeeCap: "10000000000",
                minLiquidationAbs: "0",
                // Auto-derived — see lib/market-params.ts (mirrors the merged path).
                maxPriceMoveBpsPerSlot: String(derived.maxPriceMoveBpsPerSlot),
                maxAccrualDtSlots: String(derived.maxAccrualDtSlots),
                maxAbsFundingE9PerSlot: "0",
                minFundingLifetimeSlots: "500",
                maxAccountBSettlementChunks: "10",
                maxBankruptCloseChunks: "10",
                maxBankruptCloseLifetimeSlots: "500",
                publicBChunkAtoms: "1000000000000",
                maintenanceFeePerSlot: "0",
              };
              const initMarketData = encodeInitMarket(v17InitArgs);

              // v18 InitMarket takes exactly 3 accounts [admin, slab, mint] — see the
              // M1 fix note above (~line 987) and ACCOUNTS_INIT_MARKET in the v18 SDK.
              // The old 9-account array (vault ATA, token program, clock, rent, vault
              // PDA, system program) tripped the "Account count mismatch: expected 3,
              // got 9" guard on this resume-Step-0/retry path.
              const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, {
                admin: wallet.publicKey,
                slab: slabPk,
                mint: params.mint,
              });
              const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

              const sig = await sendTx({
                connection, wallet,
                abortSignal,
                instructions: [createAtaIx, initMarketIx],
                computeUnits: 250_000,
              });
              setState((s) => ({
                ...s,
                txSigs: [...s.txSigs, sig],
                slabAddress: slabKp.publicKey.toBase58(),
              }));
            }
          } else {
            // Fresh creation — atomic: createAccount + createATA + InitMarket.
            //
            // W11 fix (2026-07-08): this block used to pre-flight-check + auto-fund (via
            // /api/devnet-pre-fund) MIN_INIT_MARKET_SEED (500 tokens) and bundle a Transfer
            // into the vault ATA before InitMarket. launch-test-market.ts (the proven 8/8
            // on-chain reference) never seeds the vault before InitMarket and it succeeds —
            // the engine doesn't require or account for a pre-existing vault balance. This
            // was pure unnecessary friction (an extra token requirement + a devnet-pre-fund
            // round-trip) on the very first step of every market creation attempt; removed.

            const effectiveSlabSize = params.slabDataSize ?? DEFAULT_SLAB_SIZE;
            const slabRent = await connection.getMinimumBalanceForRentExemption(effectiveSlabSize);

            // PERC-509: Pre-check SOL balance before attempting createAccount.
            // Without this, the tx fails with an opaque "insufficient lamports" error.
            // We need slabRent + ~0.01 SOL for ATA creation + tx fees.
            const solBalance = await connection.getBalance(wallet.publicKey);
            const minSolRequired = slabRent + 10_000_000; // rent + ~0.01 SOL for fees
            if (solBalance < minSolRequired) {
              const solNeeded = (minSolRequired / 1e9).toFixed(3);
              const solHave = (solBalance / 1e9).toFixed(3);
              if (isDevnetEnv) {
                // Auto-airdrop SOL on devnet
                setState((s) => ({ ...s, stepLabel: "Airdropping SOL for slab rent..." }));
                try {
                  const airdropSig = await connection.requestAirdrop(
                    wallet.publicKey,
                    Math.max(2_000_000_000, minSolRequired - solBalance + 500_000_000),
                  );
                  const airdropConfirm = await connection.confirmTransaction(airdropSig, "confirmed");
                  if (airdropConfirm.value.err) {
                    throw new Error(`Airdrop transaction failed on-chain: ${JSON.stringify(airdropConfirm.value.err)}`);
                  }
                  setState((s) => ({ ...s, stepLabel: STEP_LABELS[0] }));
                } catch (airdropErr) {
                  throw new Error(
                    `Insufficient SOL (have ${solHave}, need ~${solNeeded}). ` +
                    `Devnet airdrop failed — try again in a few seconds or use the faucet at faucet.solana.com.`
                  );
                }
              } else {
                throw new Error(
                  `Insufficient SOL for slab rent. You need ~${solNeeded} SOL but your wallet has ${solHave} SOL. ` +
                  `The slab account requires ${(slabRent / 1e9).toFixed(3)} SOL in rent-exemption fees.`
                );
              }
            }

            const createAccountIx = SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: slabKp.publicKey,
              lamports: slabRent,
              space: effectiveSlabSize,
              programId,
            });

            const createAtaIx = createAssociatedTokenAccountInstruction(
              wallet.publicKey, vaultAta, vaultPda, params.mint,
            );

            // Margin and the price-move budget share one derivation — see
            // lib/market-params.ts.
            const initialMarginBps = BigInt(derived.initialMarginBps);
            const v17InitArgs: InitMarketV17Args = {
              maxPortfolioAssets: 14,
              hMin: "1000",
              hMax: "100000",
              initialPrice: params.initialPriceE6.toString(),
              minNonzeroMmReq: "1000000",
              minNonzeroImReq: "2000000",
              maintenanceMarginBps: String(derived.maintenanceMarginBps),
              initialMarginBps: initialMarginBps.toString(),
              maxTradingFeeBps: BigInt(params.tradingFeeBps).toString(),
              tradeFeeBaseBps: BigInt(params.tradingFeeBps).toString(),
              liquidationFeeBps: "50",
              liquidationFeeCap: "10000000000",
              minLiquidationAbs: "0",
              // Auto-derived — see lib/market-params.ts (mirrors the other paths).
              maxPriceMoveBpsPerSlot: String(derived.maxPriceMoveBpsPerSlot),
              maxAccrualDtSlots: String(derived.maxAccrualDtSlots),
              maxAbsFundingE9PerSlot: "0",
              minFundingLifetimeSlots: "500",
              maxAccountBSettlementChunks: "10",
              maxBankruptCloseChunks: "10",
              maxBankruptCloseLifetimeSlots: "500",
              publicBChunkAtoms: "1000000000000",
              maintenanceFeePerSlot: "0",
            };
            const initMarketData = encodeInitMarket(v17InitArgs);

            // v18 InitMarket takes exactly 3 accounts [admin, slab, mint] — see the
            // M1 fix note above (~line 987). The old 9-account array (vault ATA,
            // token program, clock, rent, vault PDA, system program) tripped the
            // "Account count mismatch: expected 3, got 9" guard on this fresh-
            // creation-via-sequential-flow path.
            const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, {
              admin: wallet.publicKey,
              slab: slabPk,
              mint: params.mint,
            });
            const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

            const sig = await sendTx({
              connection,
              wallet,
              abortSignal,
              instructions: [createAccountIx, createAtaIx, initMarketIx],
              computeUnits: 300_000,
              signers: [slabKp],
              maxRetries: 0, // Don't auto-retry createAccount — use manual retry instead
            });

            setState((s) => ({
              ...s,
              txSigs: [...s.txSigs, sig],
              slabAddress: slabKp.publicKey.toBase58(),
            }));
            updateInFlightStep(slabPk.toBase58(), 1);
          }
        } else {
          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
        }

        // Step 1: Oracle setup + pre-LP crank
        // v17: SetOracleAuthority (tag 17), PushOraclePrice (tag 16), SetOraclePriceCap (tag 16),
        // and UpdateConfig (tag 14) do not exist. All oracle + risk params are embedded in InitMarket.
        // For v17, Step 1 only runs the pre-LP crank (no oracle setup needed).
        //
        // v12: full oracle setup + UpdateConfig + crank is still required.
        //
        // We detect v17 by reading the newly created slab account and checking V17_MAGIC.
        if (startStep <= 1) {
          setState((s) => ({ ...s, step: 1, stepLabel: STEP_LABELS[1] }));

          const instructions: TransactionInstruction[] = [];

          // Detect if this is a v17 slab (v17 magic at bytes 0-7).
          //
          // This must FAIL CLOSED. It used to default to false and swallow the error, so any
          // hiccup reading a slab we had just created routed a v17 market down the legacy v12
          // branch below — which calls sdk-compat stubs that THROW by design (the instructions
          // were removed on-chain in beta.29). The user then saw an opaque
          // "[sdk-compat] ... removed in beta.29" instead of the real problem.
          //
          // The slab was created moments ago in this same flow, so a null read is an ordinary
          // propagation race, not an exceptional case. Retry, and if v17-ness still cannot be
          // established, say so plainly rather than guessing "v12".
          let isV17Slab: boolean | null = null;
          let lastDetectErr: unknown = null;
          for (let attempt = 0; attempt < 5 && isV17Slab === null; attempt++) {
            try {
              const newSlabInfo = await connection.getAccountInfo(slabPk, "confirmed");
              if (newSlabInfo?.data) {
                isV17Slab = isV17Account(new Uint8Array(newSlabInfo.data));
                break;
              }
            } catch (e) {
              lastDetectErr = e;
            }
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          }
          if (isV17Slab === null) {
            throw new Error(
              `Could not read the market account ${slabPk.toBase58()} just after creating it, ` +
                `so its program version could not be determined. Nothing further was sent. ` +
                `Retry the oracle setup step.` +
                (lastDetectErr ? ` (last read error: ${String(lastDetectErr)})` : ""),
            );
          }

          if (!isV17Slab && isAdminOracle) {
            // v12 admin oracle setup (removed in v17):
            // SetOracleAuthority → PushOraclePrice → SetOraclePriceCap → UpdateConfig
            // These are only included for legacy v12 programs — v17 embeds this in InitMarket.
            const { encodeSetOracleAuthority, encodePushOraclePrice, ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE } = await import("@/lib/sdk-compat");

            const setAuthToUserData = encodeSetOracleAuthority({ newAuthority: wallet.publicKey });
            const setAuthToUserKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
              wallet.publicKey, slabPk,
            ]);
            instructions.push(buildIx({ programId, keys: setAuthToUserKeys, data: setAuthToUserData }));

            const jupiterCA = params.mainnetCA ?? params.mint.toBase58();
            const freshPriceE6 = await fetchJupiterPriceE6(jupiterCA);
            const resolvedPriceE6 = freshPriceE6 ?? params.initialPriceE6;

            const now = Math.floor(Date.now() / 1000);
            const pushData = encodePushOraclePrice({
              priceE6: resolvedPriceE6.toString(),
              timestamp: now.toString(),
            });
            const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
              wallet.publicKey, slabPk,
            ]);
            instructions.push(buildIx({ programId, keys: pushKeys, data: pushData }));

            // NOTE: SetOraclePriceCap (tag 16) and UpdateConfig (tag 14) were removed in v17.
            // They are not called here — oracle parameters are embedded in InitMarket for v17
            // and this block is only reached for !isV17Slab (legacy v12). In the v17 SDK
            // both functions throw `removedInstruction()` so they cannot be safely imported.
            // v12 circuit-breaker and funding params are omitted in this fallback path.
          }
          // v17 note: isAdminOracle for v17 slabs → oracle params already in InitMarket;
          // no SetOracleAuthority / PushOraclePrice / SetOraclePriceCap / UpdateConfig needed.

          // Keeper oracle mode (v17): ConfigureAuthMark + UpdateAssetAuthority(Oracle → keeper).
          // The backend co-signs UpdateAssetAuthority (as the new oracle_authority = keeper).
          // After this tx: oracle_mode=3 (AUTH_MARK), oracle_authority=keeperPubkey.
          if (isKeeperOracle && isV17Slab) {
            setState((s) => ({ ...s, stepLabel: "Delegating oracle authority to keeper..." }));
            const cosignResp = await fetch("/api/playground/keeper-cosign", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                deployer: wallet.publicKey.toBase58(),
                slabAddress: slabPk.toBase58(),
                initialPriceE6: params.initialPriceE6.toString(),
                assetIndex: 0,
              }),
            });
            if (!cosignResp.ok) {
              const errData = await cosignResp.json().catch(() => ({ error: "co-sign failed" }));
              throw new Error(
                `Keeper co-sign failed (${cosignResp.status}): ${(errData as { error?: string }).error ?? cosignResp.statusText}. ` +
                `Is PLAYGROUND_KEEPER_KEYPAIR set in server env?`,
              );
            }
            const { partialTxBase64 } = await cosignResp.json() as { partialTxBase64: string };

            // Deserialize the partially-signed tx (keeper has signed UpdateAssetAuthority)
            const partialTxBytes = Buffer.from(partialTxBase64, "base64");
            const partialTx = Transaction.from(partialTxBytes);

            // Wallet signs (adds creator sig for ConfigureAuthMark + UpdateAssetAuthority)
            if (!wallet.signTransaction) throw new Error("Wallet does not support signTransaction");
            const signedTx = await wallet.signTransaction(partialTx);

            // Send the fully-signed tx
            const keeperDelegateSig = await connection.sendRawTransaction(signedTx.serialize(), {
              skipPreflight: false,
            });
            const keeperDelegateConfirm = await connection.confirmTransaction(keeperDelegateSig, "confirmed");
            if (keeperDelegateConfirm.value.err) {
              throw new Error(
                `Keeper delegate tx failed on-chain: ${JSON.stringify(keeperDelegateConfirm.value.err)}`,
              );
            }
            setState((s) => ({ ...s, txSigs: [...s.txSigs, keeperDelegateSig] }));
          }

          // Pre-LP crank — v17 PermissionlessCrank requires a portfolio at accounts[2].
          // For v17 slabs, we skip the pre-LP crank (oracle is managed by UpdateAssetLifecycle
          // server-side; no oracle account required here). For v12 legacy slabs, use the old path.
          if (isV17Slab) {
            // v17: No pre-LP crank needed — oracle state is in UpdateAssetLifecycle (tag 66),
            // not in the slab bitmap. The crank will run server-side (keeper) after market creation.
            // Skip: encodeUpdateHyperpMark() throws removedInstruction() in v17 SDK.

            // BUG FIX (devnet flow-test 2026-07-01): the wizard never created the per-market
            // nft_registry PDA. MintPositionNft (useMintPositionNft.ts) and NftBurn both only
            // READ the registry — nothing in the frontend ever initialized it — so the first
            // "Mint NFT" attempt on ANY wizard-created market failed on-chain with Custom(26)
            // "nft_registry not owned by the percolator program" (see flowtest/07-nft-mint
            // .result.json's flag_for_flow_14 finding, reproduced+fixed in flowtest/14-create
            // -market.ts). SetNftProgramId (tag 73) is marketauth-gated and creates the
            // registry; marketauth == the creator wallet (accounts[0] passed to InitMarket
            // above), so the creator can always call this themselves right after market
            // creation — no separate admin bootstrap needed. Accounts/encoding verified against
            // percolator-prog src/v16_program.rs:13106-13112 (handle_set_nft_program_id) and
            // proven working on-chain via flowtest/_setup-nft-registry.ts on the 5 seeded
            // markets, and now also via flowtest/14-create-market.ts on a wizard-created one.
            // This was previously the ONLY instruction in this step for a v17+admin-oracle
            // market, so Step 1 sent a functionally-empty (compute-budget-only) transaction —
            // this fix also makes that transaction do useful work instead of nothing.
            // W1 fix (2026-07-08): a cross-session RESUME used to always re-run this step
            // regardless of whether SetNftProgramId already landed in a prior attempt —
            // the registry PDA is init-once, so a re-send reverts on-chain with
            // AlreadyInitialized and strands the resume. Check for the registry first
            // (same idempotency pattern Steps 2/4/5 already use) and skip if it's there.
            const [nftRegistryPda] = deriveNftRegistry(programId, slabPk);
            const existingNftRegistry = await connection.getAccountInfo(nftRegistryPda);
            if (!existingNftRegistry) {
              instructions.push(
                buildIx({
                  programId,
                  keys: [
                    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                    { pubkey: slabPk, isSigner: false, isWritable: false },
                    { pubkey: nftRegistryPda, isSigner: false, isWritable: true },
                    { pubkey: WELL_KNOWN.systemProgram, isSigner: false, isWritable: false },
                  ],
                  data: encodeSetNftProgramId({ nftProgramId: PERCOLATOR_NFT_PROGRAM_ID }),
                }),
              );
            } else {
              console.log("[useCreateMarket] Step 1: nft_registry already exists — skipping SetNftProgramId.");
            }
          } else if (!isV17Slab && isHyperpOracle && params.dexPoolAddress) {
            // v12 hyperp oracle — encodeUpdateHyperpMark is removed; log a warning and skip.
            // v12 hyperp markets on the v17 binary are not supported.
            console.warn("[useCreateMarket] v12 hyperp oracle mode not supported on v17 binary; skipping pre-LP crank");
          } else if (!isV17Slab) {
            // v12 legacy: KeeperCrank for Pyth and admin modes
            const crankData = encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) });
            const oracleAccount = isAdminOracle ? slabPk : derivePythPushOraclePDA(params.oracleFeed)[0];
            const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
              wallet.publicKey, slabPk, slabPk,
            ]);
            // Append oracle tail for Pyth mode
            if (!isAdminOracle) {
              crankKeys.push({ pubkey: oracleAccount, isSigner: false, isWritable: false });
            }
            instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));
          }

          // NOTE: Do NOT delegate oracle authority here — SetOracleAuthority clears
          // authority_price_e6 to 0, which would break the final crank in Step 4.
          // Delegation happens at the very end of Step 4 instead.

          // W1 fix: on a resume where every Step 1 instruction was already skipped as
          // idempotent (e.g. nft_registry already exists, v17 needs nothing else here),
          // don't send a pointless zero-instruction transaction.
          if (instructions.length > 0) {
            const sig = await sendTx({
              connection, wallet, instructions, computeUnits: 500_000,
              abortSignal,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
          }
          updateInFlightStep(slabPk.toBase58(), 2);
        }

        // Step 2: v17 LP init sequence:
        //   TX A — create portfolio account + InitPortfolio (tag 1)
        //   TX B — createAccount(matcherCtx, MATCHER_CONTEXT_LEN, matcherProgramId) (account only)
        //   TX C — SetMatcherConfig (tag 68) on the LP portfolio
        //   TX D — InitMatcherCtx (tag 83) on the WRAPPER (CPI-relays into the matcher program)
        // v12: encodeInitLP (tag 2) was used here but is REMOVED in v17 (throws removedInstruction).
        //
        // BUG FIX (devnet flow-test 2026-07-01, flowtest/debug-matcherinit-split.ts): TX B used
        // to call the matcher program DIRECTLY with encodeMatcherInitPassive ([delegate(ro),
        // ctx(w)]). That always failed on-chain with a raw ProgramError::MissingRequiredSignature
        // at ~577 CU — confirmed (via an unsigned-simulate diagnostic) that the deployed matcher
        // binary requires the matcher_delegate PDA to be isSigner:true in that call, which is
        // impossible to satisfy with a plain client-side keypair (PDAs have no private key).
        // The SDK's InitMatcherCtx (tag 83) doc comment confirms this is by design: "The wrapper
        // calls derive_matcher_delegate and invoke_signed so the delegate PDA acts as a signer in
        // the matcher CPI — this is what satisfies the matcher's lp_pda.is_signer check on the
        // deployed binary. No client-side signer of the delegate is needed." Every wizard-created
        // market's LP would have been stuck with an unusable (never-initialized) matcher context
        // until this fix — TradeCpi against that LP would fail (matcher config present but
        // matcher_ctx account uninitialized). PREREQUISITE ordering (per InitMatcherCtx's own doc
        // comment) also changed: SetMatcherConfig (TX C) must land BEFORE InitMatcherCtx (TX D),
        // since the wrapper cross-checks the LP portfolio's stored matcher config before CPI-ing.
        if (startStep <= 2) {
          setState((s) => ({ ...s, step: 2, stepLabel: STEP_LABELS[2] }));

          const matcherProgramId = new PublicKey(getConfig().matcherProgramId);

          // ── v17 LP init ──────────────────────────────────────────────────────
          // Check if a v17 slab — LP init path differs between v17 and v12.
          const slabInfoForStep2 = await connection.getAccountInfo(slabPk);
          const isV17SlabStep2 = slabInfoForStep2?.data
            ? isV17Account(new Uint8Array(slabInfoForStep2.data))
            : false;

          if (isV17SlabStep2) {
            // W1 fix (2026-07-08): idempotency guard — a cross-session RESUME (or a
            // same-session retry after a client-side confirmation timeout that actually
            // landed on-chain) used to unconditionally re-run TX A-D, generating a BRAND
            // NEW lpPortfolio/matcherCtx pair every time and leaving the earlier one
            // orphaned. Scan for an already-created LP portfolio first — same
            // magic+market+owner filter Step 3 below uses to FIND this portfolio — and
            // skip the whole TX A-D sequence if one already exists (mirrors the
            // existence-check pattern Steps 4/5 already use for their own accounts).
            const V17_MAGIC_BYTES_STEP2 = Buffer.from([
              0x00,
              0x36,
              0x31,
              0x56,
              0x43,
              0x52,
              0x45,
              0x50,
            ]);

            const walletPublicKeyStep2 = wallet.publicKey;

            if (!walletPublicKeyStep2) {
              throw new Error(
                "Wallet disconnected while recovering Step 2.",
              );
            }

            const buildInitMatcherCtxInstruction = (
              lpPortfolioPk: PublicKey,
              matcherCtxPk: PublicKey,
              delegatePk: PublicKey,
            ): TransactionInstruction =>
              buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
                  lpOwner: walletPublicKeyStep2,
                  market: slabPk,
                  lpPortfolio: lpPortfolioPk,
                  matcherCtx: matcherCtxPk,
                  matcherProg: matcherProgramId,
                  matcherDelegate: delegatePk,
                }),
                data: encodeInitMatcherCtx({
                  kind: 0,
                  tradingFeeBps: Number(params.tradingFeeBps),
                  baseSpreadBps: 50,
                  maxTotalBps: 200,
                  impactKBps: 0,
                  liquidityNotionalE6: 0n,
                  // LP guardrails — mirrors the merged path. See lib/market-params.ts.
                  maxFillAbs: derived.maxFillAbs,
                  maxInventoryAbs: derived.maxInventoryAbs,
                  feeToInsuranceBps: 0,
                  skewSpreadMultBps: derived.skewSpreadMultBps,
                }),
              });

            const sendMatcherContextInitialization = async (
              lpPortfolioPk: PublicKey,
              matcherCtxPk: PublicKey,
              delegatePk: PublicKey,
            ): Promise<void> => {
              const initMatcherCtxIx = buildInitMatcherCtxInstruction(
                lpPortfolioPk,
                matcherCtxPk,
                delegatePk,
              );

              const signature = await sendTx({
                connection,
                wallet,
                abortSignal,
                instructions: [initMatcherCtxIx],
                computeUnits: 200_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, signature],
              }));
            };

            const inspectConfiguredMatcherState = async (
              lpPortfolioPk: PublicKey,
              portfolioData: Uint8Array,
            ) => {
              const matcherConfig =
                readV17PortfolioMatcherConfig(portfolioData);

              if (!matcherConfig.enabled) {
                throw new Error(
                  "Existing LP portfolio has incomplete matcher initialization: " +
                    "matcher configuration is disabled; cannot safely advance " +
                    "past Step 2.",
                );
              }

              if (!matcherConfig.matcherProgram.equals(matcherProgramId)) {
                throw new Error(
                  "Cannot safely resume Step 2: the existing LP portfolio " +
                    "references an unexpected matcher program.",
                );
              }

              if (matcherConfig.matcherContext.equals(PublicKey.default)) {
                throw new Error(
                  "Existing LP portfolio has incomplete matcher initialization: " +
                    "matcher context is not configured; cannot safely advance " +
                    "past Step 2.",
                );
              }

              const [expectedDelegatePk] = deriveMatcherDelegate(
                programId,
                slabPk,
                lpPortfolioPk,
                walletPublicKeyStep2,
                matcherProgramId,
                matcherConfig.matcherContext,
              );

              if (!matcherConfig.matcherDelegate.equals(expectedDelegatePk)) {
                throw new Error(
                  "Cannot safely resume Step 2: the stored matcher delegate " +
                    "does not match the expected PDA.",
                );
              }

              const matcherContextInfo = await connection.getAccountInfo(
                matcherConfig.matcherContext,
              );

              if (!matcherContextInfo) {
                throw new Error(
                  "Existing LP portfolio has incomplete matcher initialization: " +
                    "the configured matcher-context account does not exist; " +
                    "cannot safely advance past Step 2.",
                );
              }

              if (!matcherContextInfo.owner.equals(matcherProgramId)) {
                throw new Error(
                  "Cannot safely resume Step 2: the matcher-context account " +
                    "is owned by an unexpected program.",
                );
              }

              const contextState = inspectV17MatcherContext(
                new Uint8Array(matcherContextInfo.data),
                expectedDelegatePk,
              );

              if (contextState === "invalid") {
                throw new Error(
                  "Cannot safely resume Step 2: the matcher-context account " +
                    "has an invalid layout or is bound to another delegate.",
                );
              }

              return {
                matcherConfig,
                expectedDelegatePk,
                contextState,
              };
            };

            const verifyMatcherReadiness = async (
              lpPortfolioPk: PublicKey,
            ): Promise<void> => {
              const freshPortfolioInfo =
                await connection.getAccountInfo(lpPortfolioPk);

              if (!freshPortfolioInfo) {
                throw new Error(
                  "Matcher recovery could not be verified: the LP portfolio " +
                    "account was not found after recovery.",
                );
              }

              if (!freshPortfolioInfo.owner.equals(programId)) {
                throw new Error(
                  "Matcher recovery could not be verified: the LP portfolio " +
                    "is owned by an unexpected program.",
                );
              }

              if (
                freshPortfolioInfo.data.length !==
                V17_PORTFOLIO_ACCOUNT_LEN
              ) {
                throw new Error(
                  "Matcher recovery could not be verified: the LP portfolio " +
                    `has an unexpected length (${freshPortfolioInfo.data.length}).`,
                );
              }

              const verifiedState = await inspectConfiguredMatcherState(
                lpPortfolioPk,
                new Uint8Array(freshPortfolioInfo.data),
              );

              if (verifiedState.contextState !== "initialized") {
                throw new Error(
                  "Matcher recovery transaction completed, but authoritative " +
                    "on-chain state still reports an uninitialized matcher context.",
                );
              }
            };

            const createAndInitializeMatcher = async (
              lpPortfolioPk: PublicKey,
            ): Promise<void> => {
              // TX B: create the matcher-program-owned context account.
              const matcherCtxKp = Keypair.generate();
              const matcherCtxPk = matcherCtxKp.publicKey;

              const matcherCtxRent =
                await connection.getMinimumBalanceForRentExemption(
                  MATCHER_CONTEXT_LEN,
                );

              const createCtxIx = SystemProgram.createAccount({
                fromPubkey: walletPublicKeyStep2,
                newAccountPubkey: matcherCtxPk,
                lamports: matcherCtxRent,
                space: MATCHER_CONTEXT_LEN,
                programId: matcherProgramId,
              });

              const [delegatePk] = deriveMatcherDelegate(
                programId,
                slabPk,
                lpPortfolioPk,
                walletPublicKeyStep2,
                matcherProgramId,
                matcherCtxPk,
              );

              const contextSignature = await sendTx({
                connection,
                wallet,
                abortSignal,
                instructions: [createCtxIx],
                signers: [matcherCtxKp],
                computeUnits: 150_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, contextSignature],
              }));

              // TX C: commit the context and delegate to the LP portfolio.
              // v18: live-read the LP portfolio identity (recovery path — the
              // matcher-sequence reflects any prior InitUser/Deposit). assetGenFrontier
              // = max_market_slots + 1 (V17_MAX_PORTFOLIO_ASSETS + 1).
              const smInfo = await connection.getAccountInfo(lpPortfolioPk);
              if (!smInfo?.data) throw new Error("LP portfolio not found for SetMatcherConfig");
              const smId = readPortfolioIdentity(new Uint8Array(smInfo.data));
              const setMatcherConfigIx = buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, {
                  lpOwner: walletPublicKeyStep2,
                  market: slabPk,
                  lpPortfolio: lpPortfolioPk,
                  matcherProg: matcherProgramId,
                  matcherCtx: matcherCtxPk,
                  matcherDelegate: delegatePk,
                }),
                data: encodeSetMatcherConfig({
                  portfolioId: smId.portfolioId,
                  expectedSequence: smId.matcherSequence,
                  assetGenerationFrontier: BigInt(V17_MAX_PORTFOLIO_ASSETS) + 1n,
                  enabled: 1,
                  tradeFeeCapBps: 10_000,
                  expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT,
                }),
              });

              const configSignature = await sendTx({
                connection,
                wallet,
                abortSignal,
                instructions: [setMatcherConfigIx],
                computeUnits: 200_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, configSignature],
              }));

              // TX D: initialize the committed matcher context through the wrapper.
              await sendMatcherContextInitialization(
                lpPortfolioPk,
                matcherCtxPk,
                delegatePk,
              );
            };

            const existingLpPortfolios =
              await connection.getProgramAccounts(programId, {
                filters: [
                  { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
                  {
                    memcmp: {
                      offset: 0,
                      bytes: V17_MAGIC_BYTES_STEP2.toString("base64"),
                      encoding: "base64",
                    },
                  },
                  {
                    memcmp: {
                      offset: 16,
                      bytes: slabPk.toBase58(),
                    },
                  },
                  {
                    memcmp: {
                      offset: 80,
                      bytes: walletPublicKeyStep2.toBase58(),
                    },
                  },
                ],
              });

            if (existingLpPortfolios.length === 0) {
              // TX A: create and initialize the LP portfolio.
              const lpPortfolioKp = Keypair.generate();
              const lpPortfolioPk = lpPortfolioKp.publicKey;

              const portfolioRent =
                await connection.getMinimumBalanceForRentExemption(
                  V17_PORTFOLIO_ACCOUNT_LEN,
                );

              const createPortfolioIx = SystemProgram.createAccount({
                fromPubkey: walletPublicKeyStep2,
                newAccountPubkey: lpPortfolioPk,
                lamports: portfolioRent,
                space: V17_PORTFOLIO_ACCOUNT_LEN,
                programId,
              });

              const initPortfolioIx = buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_INIT_USER, {
                  owner: walletPublicKeyStep2,
                  market: slabPk,
                  portfolio: lpPortfolioPk,
                }),
                data: encodeInitUser({}),
              });

              const portfolioSignature = await sendTx({
                connection,
                wallet,
                abortSignal,
                instructions: [createPortfolioIx, initPortfolioIx],
                signers: [lpPortfolioKp],
                computeUnits: 200_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, portfolioSignature],
              }));

              await createAndInitializeMatcher(lpPortfolioPk);
              await verifyMatcherReadiness(lpPortfolioPk);
            } else {
              if (existingLpPortfolios.length !== 1) {
                throw new Error(
                  `Cannot safely resume Step 2: expected exactly one LP portfolio, ` +
                    `found ${existingLpPortfolios.length}.`,
                );
              }

              const existingLpPortfolio = existingLpPortfolios[0];

              if (!existingLpPortfolio) {
                throw new Error(
                  "Cannot safely resume Step 2: the LP portfolio lookup " +
                    "returned an empty result.",
                );
              }

              const lpPortfolioPk = existingLpPortfolio.pubkey;
              const lpPortfolioAccount = existingLpPortfolio.account;

              if (!lpPortfolioAccount.owner.equals(programId)) {
                throw new Error(
                  "Cannot safely resume Step 2: the existing LP portfolio " +
                    "is not owned by the configured wrapper program.",
                );
              }

              const matcherConfig = readV17PortfolioMatcherConfig(
                new Uint8Array(lpPortfolioAccount.data),
              );

              if (!matcherConfig.enabled) {
                if (!isEmptyV17PortfolioMatcherConfig(matcherConfig)) {
                  throw new Error(
                    "Existing LP portfolio has incomplete matcher initialization: " +
                      "the disabled matcher configuration contains committed " +
                      "fields; cannot safely advance past Step 2.",
                  );
                }

                // TX A already landed. Resume only TX B, TX C, and TX D.
                await createAndInitializeMatcher(lpPortfolioPk);
                await verifyMatcherReadiness(lpPortfolioPk);

                console.log(
                  "[useCreateMarket] Step 2 recovered missing matcher " +
                    "context/config/initialization (TX B-D).",
                );
              } else {
                const configuredState =
                  await inspectConfiguredMatcherState(
                    lpPortfolioPk,
                    new Uint8Array(lpPortfolioAccount.data),
                  );

                if (configuredState.contextState === "uninitialized") {
                  // TX A-C already landed. Resume only TX D using the committed context.
                  await sendMatcherContextInitialization(
                    lpPortfolioPk,
                    configuredState.matcherConfig.matcherContext,
                    configuredState.expectedDelegatePk,
                  );

                  await verifyMatcherReadiness(lpPortfolioPk);

                  console.log(
                    "[useCreateMarket] Step 2 recovered the missing matcher " +
                      "context initialization (TX D only).",
                  );
                } else {
                  console.log(
                    "[useCreateMarket] Step 2 matcher state verified on-chain - " +
                      "skipping duplicate TX A-D.",
                  );
                }
              }
            }

            updateInFlightStep(slabPk.toBase58(), 3);
          } else {
            // v12 legacy: encodeInitLP (tag 2) is removed in v17 — skip for v17 slabs.
            // For v12 slabs on the old binary, this path would be used but is no longer supported.
            console.warn("[useCreateMarket] v12 InitLP is removed in v17. Skipping LP init for non-v17 slab.");
            updateInFlightStep(slabPk.toBase58(), 3);
          }
        }

        // Step 3: DepositCollateral + TopUpInsurance + Final Crank (merged)
        if (startStep <= 3) {
          setState((s) => ({ ...s, step: 3, stepLabel: STEP_LABELS[3] }));

          const userAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);

          // Pre-flight: verify user has enough tokens for LP deposit + insurance top-up.
          // Fixes #757/#758 — pre-fund only checked seed amount (500), but TX4 also
          // needs lpCollateral + insuranceAmount (default 1,000 + 100 = 1,100 more).
          // Covers the two backing-bucket deposits (long+short domains) as well
          // as the LP deposit and insurance. Shared with the pre-fund route via
          // fullMarketRequirement so the two cannot disagree again (GH#2592).
          const tx4Required = fullMarketRequirement(params.lpCollateral, params.insuranceAmount);
          let tx4Balance = 0n;
          try {
            const tx4Acct = await getAccount(connection, userAta);
            tx4Balance = tx4Acct.amount;
          } catch {
            // ATA doesn't exist — balance stays 0
          }
          if (tx4Balance < tx4Required) {
            if (isDevnetEnv) {
              setState((s) => ({ ...s, stepLabel: "Funding devnet wallet for deposit..." }));
              const fundResp4 = await fetch("/api/devnet-pre-fund", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mintAddress: params.mint.toBase58(),
                  walletAddress: wallet.publicKey.toBase58(),
                  // GH#2592: the requirement the route checks must be the one
                  // tx4Required is about, or it answers "sufficient" to the
                  // very request that says the wallet is short.
                  lpCollateral: params.lpCollateral.toString(),
                  insuranceAmount: params.insuranceAmount.toString(),
                }),
              });
              if (!fundResp4.ok) {
                const err4 = await fundResp4.json().catch(() => ({ error: "Unknown error" }));
                throw new Error(`Devnet pre-fund failed at deposit step: ${err4.error ?? fundResp4.status}`);
              }
              setState((s) => ({ ...s, stepLabel: STEP_LABELS[3] }));
            } else {
              const decimals = params.decimals ?? 6;
              const needed = Number(tx4Required) / 10 ** decimals;
              const have = Number(tx4Balance) / 10 ** decimals;
              throw new Error(
                `Insufficient token balance for deposit. ` +
                `You need ${needed.toLocaleString()} tokens for LP collateral and insurance ` +
                `but your wallet holds ${have.toLocaleString()}. ` +
                `Please add tokens to your wallet before continuing.`
              );
            }
          }

          // v17 Deposit: [owner, market, portfolio, sourceToken, vaultToken, tokenProgram] — no clock.
          // Must find or create the LP portfolio first.
          // Note: vaultPda is declared in outer scope; use the derived value here for vaultTokenAta.
          const vaultTokenAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
          // Find the LP portfolio created in Step 2 (v17 only).
          // For v12, fall back to the vault ATA as the portfolio placeholder (v12 layout had no portfolio).
          const slabInfoForDeposit = await connection.getAccountInfo(slabPk);
          const isV17SlabDeposit = slabInfoForDeposit?.data
            ? isV17Account(new Uint8Array(slabInfoForDeposit.data))
            : false;

          let depositPortfolioPk: PublicKey;
          if (isV17SlabDeposit) {
            // Scan for LP portfolio (owner = wallet, market = slabPk) — created in Step 2
            // V17 magic bytes at offset 0: PERCV16\0
            const V17_MAGIC_BYTES = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
            const portfolioAccounts = await connection.getProgramAccounts(programId, {
              filters: [
                { memcmp: { offset: 0, bytes: V17_MAGIC_BYTES.toString("base64"), encoding: "base64" } },
                { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                { memcmp: { offset: 80, bytes: wallet.publicKey.toBase58() } },
              ],
            });
            if (portfolioAccounts.length === 0) {
              throw new Error("LP portfolio not found — Step 2 (LP init) may not have completed. Please retry from step 2.");
            }
            depositPortfolioPk = portfolioAccounts[0].pubkey;
          } else {
            // v12 fallback — old deposit layout used vault ATA at [2], not a portfolio
            depositPortfolioPk = vaultAta; // kept for legacy compatibility
          }

          // v18: live-read the LP portfolio's identity CAS fields (recovery path —
          // the market may be partially set up, so fresh literals can't be assumed).
          // v12 fallback has no v18 portfolio (0n placeholders; abandoned).
          let depLpId = { portfolioId: 0n, matcherSequence: 0n };
          if (isV17SlabDeposit) {
            const lpInfo = await connection.getAccountInfo(depositPortfolioPk);
            if (!lpInfo?.data) throw new Error("LP portfolio not found for deposit");
            const pid = readPortfolioIdentity(new Uint8Array(lpInfo.data));
            depLpId = { portfolioId: pid.portfolioId, matcherSequence: pid.matcherSequence };
          }
          const depositData = encodeDepositCollateral({
            portfolioId: depLpId.portfolioId,
            expectedSequence: depLpId.matcherSequence,
            amount: params.lpCollateral.toString(),
          });
          const depositKeys = isV17SlabDeposit
            ? buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
                owner: wallet.publicKey, market: slabPk, portfolio: depositPortfolioPk,
                sourceToken: userAta, vaultToken: vaultTokenAta, tokenProgram: WELL_KNOWN.tokenProgram,
              })
            : // NOT verified against the current v18 ACCOUNTS_DEPOSIT_COLLATERAL spec
              // ([owner,market,portfolio,sourceToken,vaultToken,tokenProgram]) — this is
              // the pre-v16/v17 legacy 6-account array (userAta/vaultAta/tokenProgram/clock,
              // no portfolio account), guarded behind `!isV17SlabDeposit` and unreachable for
              // every currently-deployed market (all are v17-magic). Left as-is: fixing it
              // is out of scope for the v18 mismatch sweep and untestable against any live
              // v12 slab. Flagged in the PR report.
              buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
                wallet.publicKey, slabPk, userAta, vaultAta,
                WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
              ]);

          // v18: TopUpInsurance binds asset-0 market_id + authority_epoch (CAS,
          // current) + a strictly-increasing one-shot intentId on the shared lane.
          // Live-read the identity/epoch off the market; the lane watermark is not
          // exposed, so use the current slot as a monotonic one-shot nonce.
          const insSlabData = isV17SlabDeposit && slabInfoForDeposit?.data
            ? new Uint8Array(slabInfoForDeposit.data) : null;
          const topupData = encodeTopUpInsurance({
            marketId: insSlabData ? readAssetMarketId(insSlabData, 0) : 0n,
            intentId: BigInt(await connection.getSlot("confirmed")),
            authorityEpoch: insSlabData ? readAssetControlSeqs(insSlabData, 0).authorityEpoch : 0n,
            amount: params.insuranceAmount.toString(),
          });
          // v18 ACCOUNTS_TOPUP_INSURANCE is [signer,market,sourceToken,vaultToken,
          // tokenProgram] — 5 entries, no clock (the stale "6 entries / clock in
          // v12.19" note above no longer matches the deployed v18 SDK). Object
          // form for clarity — see ACCOUNTS_TOPUP_INSURANCE in the v18 SDK.
          const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, {
            signer: wallet.publicKey, market: slabPk, sourceToken: userAta,
            vaultToken: isV17SlabDeposit ? vaultTokenAta : vaultAta, tokenProgram: WELL_KNOWN.tokenProgram,
          });
          const topupIx = buildIx({ programId, keys: topupKeys, data: topupData });

          // W2 fix (2026-07-08): read what's already on-chain BEFORE (re)sending the
          // deposit — a prior attempt (retry from this step, or a cross-session resume)
          // may have already landed it even though the overall create() call
          // subsequently failed/threw. Without this, every retry re-deposits
          // lpCollateral ON TOP OF whatever's already there.
          let alreadyDepositedCapital = 0n;
          if (isV17SlabDeposit) {
            try {
              const portInfo = await connection.getAccountInfo(depositPortfolioPk);
              if (portInfo?.data) {
                alreadyDepositedCapital = parsePortfolioV17(new Uint8Array(portInfo.data)).capital;
              }
            } catch {
              // Treat as not-yet-deposited — fall through to deposit.
            }
          }

          // H9/W3 fix (2026-07-08): DepositCollateral used to be bundled atomically with
          // TopUpInsurance + the final crank in ONE transaction. If either of those
          // reverted, Solana rolled back the ENTIRE transaction — including the
          // (otherwise valid) deposit — stranding the user with nothing landed despite
          // having a perfectly good deposit ready to go. Send it ALONE so a topup/crank
          // failure can never roll back a deposit that would have succeeded on its own.
          // This stays on the FATAL path (unlike topup/crank below): a failed deposit
          // legitimately blocks the rest of market creation, same as before this fix.
          if (alreadyDepositedCapital < params.lpCollateral) {
            const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });
            const depositSig = await sendTx({
              connection, wallet,
              abortSignal,
              instructions: [depositIx],
              computeUnits: 200_000,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, depositSig] }));
          } else {
            console.log("[useCreateMarket] Step 3 deposit already landed (portfolio capital >= target) — skipping.");
          }

          // ── Backing-bucket-freshness deadlock prevention (2026-07-09) ──────────
          // ROOT CAUSE (percolator/src/v16.rs prepare_counterparty_backing_add_delta,
          // ~line 755): a source-domain backing bucket that is Fresh-but-lapsed
          // (current_slot >= expiry_slot) permanently reverts Custom(21) LockActive
          // the next time ANYTHING requests a new (later) finite expiry for it —
          // which happens AUTOMATICALLY inside the engine's loss-reserve path
          // (reserve_new_capital_backed_loss_for_source_domain_not_atomic) the
          // first time either side of a trade realizes a genuine loss. The only
          // escape (expire_source_backing_bucket_not_atomic) is reachable exclusively
          // from a Resolved-market terminal close — dead code for a Live market.
          //
          // CreateLpVault (Step 4 below) does NOT protect against this: it only
          // creates the LP-vault registry/mint PDAs (handle_create_lp_vault,
          // v16_program.rs:11646) — it never calls DepositToLpVault, so it never
          // touches a backing bucket. Seeding only ever happens if/when someone
          // later, optionally, calls the permissionless DepositToLpVault from the
          // Earn page (by design — "anyone, including the creator, later" — see the
          // Step 4 comment) — not guaranteed for any given market, and even then
          // only for domain 0 (long); there is no equivalent for domain 1 (short).
          //
          // FIX: explicitly seed BOTH domains (long=0, short=1) to
          // Fresh@MAX_BACKING_BUCKET_EXPIRY_SLOT (u64::MAX/2) here, deterministically,
          // as part of market creation — while both buckets are still Empty (no
          // Step 0-5 instruction ever calls TradeCpi). fresh_counterparty_backing_
          // expiry_slot() then always returns this same MAX value, so every later
          // automatic loss-reserve request matches the existing expiry and hits the
          // harmless no-op arm — the LockActive trap becomes unreachable for this
          // market's lifetime. backing_bucket_authority defaults to config.marketauth
          // at InitMarket (== wallet.publicKey, the creator, set in Step 0) and
          // nothing in Steps 0-5 ever rotates it (Stake InitPool, Step 5, makes no
          // wrapper CPI at all — verified against percolator-stake/src/processor.rs),
          // so the connected wallet can sign this here with no prior authority setup.
          //
          // v17-only (backing-bucket domains are a v16/v17 engine concept; v12
          // legacy markets have no equivalent trap or instruction). Best-effort/
          // non-fatal like the insurance top-up above: a transient RPC failure here
          // must not strand an otherwise-successful market creation — a retry of
          // this step (or a later maintainer backfill) is safe because a repeat
          // TopUp against an already-Fresh-at-MAX bucket hits the harmless no-op arm.
          if (isV17SlabDeposit) {
            try {
              const backingVaultToken = vaultTokenAta;
              const LONG_DOMAIN = 0; // 2*assetIndex, assetIndex=0
              const SHORT_DOMAIN = 1; // 2*assetIndex+1
              // v18: TopUpBackingBucket binds asset-0 market_id + authority_epoch
              // (CAS, current) + a strictly-increasing one-shot intentId per domain.
              // Live-read the market; intentId long(0)=1, short(1)=2 on a fresh lane.
              const bbSlabInfo = await connection.getAccountInfo(slabPk);
              if (!bbSlabInfo?.data) throw new Error("Market account not found for backing seed");
              const bbSlabData = new Uint8Array(bbSlabInfo.data);
              const bbMarketId = readAssetMarketId(bbSlabData, 0);
              const bbAuthorityEpoch = readAssetControlSeqs(bbSlabData, 0).authorityEpoch;
              const backingIxs: TransactionInstruction[] = [];
              for (const domain of [LONG_DOMAIN, SHORT_DOMAIN]) {
                // v18 TOP_UP_BACKING_BUCKET grew to 7 accounts: +ledger (a
                // per-domain, handler-created PDA) +systemProgram (#433). The
                // ledger is DIFFERENT per domain — derive it inside this loop.
                // Matches the fix at ~line 1087 (main path) and the proven
                // newmarkets.ts seed; the old 5-account array here missed both
                // new accounts and silently built the wrong instruction on this
                // Step 3 resume/retry path.
                const [ledger] = deriveLpBackingLedger(programId, slabPk, domain);
                backingIxs.push(
                  buildIx({
                    programId,
                    keys: buildAccountMetas(ACCOUNTS_TOP_UP_BACKING_BUCKET, {
                      signer: wallet.publicKey,
                      market: slabPk,
                      sourceToken: userAta,
                      vaultToken: backingVaultToken,
                      tokenProgram: WELL_KNOWN.tokenProgram,
                      ledger,
                      systemProgram: WELL_KNOWN.systemProgram,
                    }),
                    data: encodeTopUpBackingBucket({
                      domain,
                      marketId: bbMarketId,
                      intentId: BigInt(domain) + 1n,
                      authorityEpoch: bbAuthorityEpoch,
                      amount: backingSeed.toString(),
                      expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT.toString(),
                    }),
                  }),
                );
              }
              const backingSig = await sendTx({
                connection, wallet,
                abortSignal,
                instructions: backingIxs,
                computeUnits: 200_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, backingSig] }));
            } catch (backingBucketErr) {
              console.warn(
                "[useCreateMarket] Step 3 backing-bucket seeding (deadlock prevention) failed — " +
                "market is otherwise live, but domains 0/1 may still be vulnerable to the freshness " +
                "deadlock until this is retried or backfilled:",
                backingBucketErr,
              );
              // GH#2514: staying non-fatal is right — a transient RPC error must
              // not strand a live market, and a repeat TopUp against an
              // already-Fresh-at-MAX bucket is a harmless no-op. Staying SILENT
              // is not. The rationale above was written when this seed was dust;
              // it is now backingSeedPerDomain(lp) per domain, so swallowing the
              // failure hands the creator a "Market created!" for a market
              // missing two allocations worth twice their LP collateral.
              setState((s) => ({ ...s, backingSeedFailed: true }));
            }
          }

          // TopUpInsurance + final crank — NOT part of the proven on-chain sequence
          // (launch-test-market.ts, the 8/8 ground truth, creates a tradeable market
          // without ever calling TopUpInsurance) and, per the H9/W3 fix above, no longer
          // bundled with the load-bearing deposit. Treat as best-effort: log and continue
          // rather than throwing, so a topup/crank revert can never strand an
          // otherwise-successful deposit or block Steps 4/5.
          // Recorded by the catch below; the outcome check after it decides.
          let topupCrankError: unknown = null;
          try {
            // W2 idempotency for the top-up: the vault ATA is dedicated to this market
            // (each market gets its own vaultAuth PDA + ATA) and — since the W11 fix
            // removed the old vault-seed transfer from Step 0 — its balance is now
            // exactly lpCollateral-deposited + insurance-topped-up. Back out the
            // insurance component from (vault balance − LP capital) instead of a direct
            // balance read (the v17 SDK exposes no typed insurance-fund accessor) and
            // skip if it's already at/above target.
            // How much insurance is ALREADY in the market.
            //
            // This used to infer it as `vaultBalance - lpCapital`, which is
            // wrong: the vault also holds the BACKING-BUCKET seeds
            // (TopUpBackingBucket, one per domain — see backingSeedPerDomain).
            // For a 1000-token LP seed that is 100 x 2 = 200 sitting in the
            // vault, so the check computed 200 "already topped up", compared it
            // against a 100 insurance seed, concluded insurance had landed, and
            // skipped the deposit. The market came up with insurance = 0 and no
            // failed transaction anywhere, because TopUpInsurance was never
            // built — verified on-chain: tag 9 appears in none of the launch
            // transactions.
            //
            // Read the real balance from the market group header instead. It is
            // the value the engine itself uses, so it cannot be confused with
            // anything else the vault happens to hold.
            let alreadyToppedUp = 0n;
            if (isV17SlabDeposit) {
              try {
                const slabInfo = await connection.getAccountInfo(slabPk);
                if (slabInfo?.data) {
                  alreadyToppedUp = parseMarketGroupV17OI(new Uint8Array(slabInfo.data)).insuranceBalance;
                }
              } catch {
                // Unreadable — treat as not-yet-topped-up and send the deposit.
                // Re-depositing is caught by the engine; skipping it is not.
              }
            }

            // Post-LP crank — engine needs to recognize LP capital
            // Must push fresh price first (user is still oracle authority at this point)
            const finalInstructions: TransactionInstruction[] = [];
            if (alreadyToppedUp < params.insuranceAmount) {
              finalInstructions.push(topupIx);
            } else {
              console.log("[useCreateMarket] Step 3 insurance top-up already landed — skipping.");
            }

            if (isAdminOracle && isLegacyOracle) {
              // PERC-465: Push fresh price again in the final crank bundle (v12 legacy path only).
              // v17: PushOraclePrice (tag 16) does not exist — oracle state is updated by the keeper.
              // Fetch from Jupiter first; fall back to the resolvedPriceE6 from step 1.
              const jupiterCA2 = params.mainnetCA ?? params.mint.toBase58();
              const freshPrice2 = await fetchJupiterPriceE6(jupiterCA2);
              const finalPriceE6 = freshPrice2 ?? params.initialPriceE6;

              const now2 = Math.floor(Date.now() / 1000);
              // NOTE: encodePushOraclePrice and ACCOUNTS_PUSH_ORACLE_PRICE are not imported
              // in the v17 SDK. This block is unreachable when isLegacyOracle = false.
              // To restore v12 support, re-import from @/lib/sdk-compat and set isLegacyOracle = true.
              void jupiterCA2; void freshPrice2; void finalPriceE6; void now2;
            }

            // v17: UpdateHyperpMark (encodeUpdateHyperpMark) is REMOVED — throws removedInstruction().
            // Hyperp oracle in v17 uses ConfigureHybridOracle (tag 34) managed server-side by keeper.
            // Final crank uses PermissionlessCrank for all oracle modes.
            // v17 PermissionlessCrank: [owner(s,w), market(w), portfolio(w)] + optional oracle tail.
            {
              const crankData = encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) });
              const crankPortfolioPk = isV17SlabDeposit ? depositPortfolioPk : slabPk;
              const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
                owner: wallet.publicKey, market: slabPk, portfolio: crankPortfolioPk,
              });
              // ONLY a pyth market carries a Pyth oracle tail. Same bug as the
              // batched path: `!isAdminOracle && !isHyperpOracle` is TRUE for a
              // keeper market, whose oracleFeed is the mainnet DEX POOL address
              // rather than a Pyth feed id — so this derived a push-oracle PDA
              // from a pool address and appended that account to the crank.
              if (oracleMode === "pyth") {
                crankKeys.push({ pubkey: derivePythPushOraclePDA(params.oracleFeed)[0], isSigner: false, isWritable: false });
              }
              finalInstructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));
            }

            // PERC-465: Oracle authority delegation (v12 legacy path only).
            // v17: SetOracleAuthority (tag 17) does not exist. Oracle authority in v17 is
            // managed via UpdateAssetAuthority (tag 65) by the market admin AFTER market creation.
            // The keeper bot picks up new v17 markets automatically via the config oracle mode.
            // PERC-470: Hyperp mode needs no delegation (oracle_authority stays zeros, permissionless).
            if (isDevnetEnv && isAdminOracle && isLegacyOracle) {
              // v12-only: SetOracleAuthority → crank wallet
              // NOTE: encodeSetOracleAuthority and ACCOUNTS_SET_ORACLE_AUTHORITY are not imported
              // in the v17 SDK. This block is unreachable when isLegacyOracle = false.
              void getConfig;
            }

            if (finalInstructions.length > 0) {
              const sig = await sendTx({
                connection, wallet,
                abortSignal,
                instructions: finalInstructions,
                computeUnits: 450_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
            }
          } catch (topupCrankErr) {
            // Recorded, not swallowed — the outcome check below decides.
            topupCrankError = topupCrankErr;
            console.warn(
              "[useCreateMarket] Step 3 insurance top-up/crank threw:",
              topupCrankErr,
            );
          }

          // The insurance seed is NOT optional: it is the layer that absorbs
          // losses before the LP does, and it is written once at creation.
          // Assert the OUTCOME rather than the transaction result — the seed can
          // be missing with no error at all (the idempotency check above can
          // skip building it) or be rolled back by the best-effort crank bundled
          // into the same transaction. Reading the engine's own insuranceBalance
          // catches never-built, reverted and partial alike.
          if (params.insuranceAmount > 0n) {
            let insuranceOnChain = 0n;
            try {
              const slabInfoFinal = await connection.getAccountInfo(slabPk);
              if (slabInfoFinal?.data) {
                insuranceOnChain = parseMarketGroupV17OI(
                  new Uint8Array(slabInfoFinal.data),
                ).insuranceBalance;
              }
            } catch {
              // Unverifiable — treat as unseeded rather than assume success.
            }
            if (insuranceOnChain < params.insuranceAmount) {
              throw new Error(
                `Insurance fund was not seeded (on-chain ${insuranceOnChain} < requested ${params.insuranceAmount}). ` +
                  "The market exists and its liquidity is deposited — retry this step to seed it." +
                  (topupCrankError
                    ? ` Cause: ${topupCrankError instanceof Error ? topupCrankError.message : String(topupCrankError)}`
                    : ""),
              );
            }
          }

          // W9 fix (2026-07-08): this call was missing entirely, so lastStep never
          // advanced past 3 after this step — see RecoverSolBanner / useStuckSlabs (W1),
          // which now resumes from stuckSlab.lastStep. Recording lastStep=4 here lets a
          // resume correctly skip Steps 0-3 (all idempotency-guarded above, but skipping
          // the RPC round-trips entirely is strictly better) and start at Step 4 (Earn
          // vault).
          updateInFlightStep(slabPk.toBase58(), 4);
        }

        // GH#1761: Register market in Supabase BEFORE Steps 4/5 (Earn vault + stake
        // pool, added below). Steps 0-3 already create a live, tradeable market — moving
        // registration here ensures symbol, mainnet_ca, and oracle_authority are stored
        // even if Step 4 or Step 5 fails. (Originally written for the now-removed
        // "Insurance LP Mint" step 5, which had the same non-fatal-tail-step shape;
        // Steps 4/5 below inherit the same "register first, then attempt" ordering.)
        //
        // PERC-8332: Attach nonce + ed25519 signature so the POST handler can verify
        // deployer ownership without Supabase. Flow:
        //   1. GET /api/markets/challenge?deployer=<pubkey> → { nonce }
        // 2. Sign the canonical market-registration payload with wallet.signMessage (ed25519)
        //   3. POST with { nonce, signature: base64 }
        // The markets-row write used to live here as a second POST /api/markets
        // guarded by its own nonce+signature challenge. Both are gone:
        // keeper-register writes the row under the marketauth proof, so a launch
        // makes ONE registration call and the weaker wallet-possession challenge
        // is redundant. See lib/market-registration.ts for why the endpoint had
        // to be removed rather than merely moved — its blanket 409 meant the
        // indexer won this race every time.

        // Step 4: Create the Earn LP vault (CreateLpVault, tag 74) — the same
        // mechanism the 5 curated/seeded markets use (see
        // percolator-v17-devnet-test/playground/newmarkets.ts step [6b], whose
        // account list + args this mirrors exactly). This MUST run BEFORE
        // Step 5 (Stake InitPool) below: Stake InitPool rotates on-chain
        // marketauth from this wallet to the stake-pool PDA
        // (stake-governs-market — the accepted design for parity with the
        // seeded markets), and CreateLpVault is marketauth-gated. Once
        // marketauth moves to a PDA (no private key to sign with), it can
        // never be called again — newmarkets.ts's "ROOT-CAUSE FIX #2" note
        // documents this exact failure mode being reproduced on-chain when
        // the ordering was reversed. Every earlier marketauth-gated call in
        // this flow (ConfigureAuthMark, UpdateAssetAuthority,
        // SetNftProgramId, SetMatcherConfig, InitMatcherCtx) already relies
        // on the same "marketauth == creator wallet until Stake InitPool"
        // invariant — Step 4/5 just extend it by two more steps.
        //
        // No initial DepositToLpVault here, by design: the LP Vault Registry
        // PDA existing on-chain is sufficient for the Earn page to treat the
        // vault as live — see `lpVaultState.registryExists` in
        // app/earn/[slab]/page.tsx, which drives "Pool Status: Active" purely
        // off account existence, not balance. Forcing the creator to seed a
        // deposit here would add an extra funding requirement with no
        // functional benefit; anyone (including the creator, later) can be
        // the vault's first depositor from the Earn page.
        if (startStep <= 4) {
          setState((s) => ({ ...s, step: 4, stepLabel: STEP_LABELS[4] }));

          const [lpVaultRegistry] = deriveLpVaultRegistry(programId, slabPk);
          const [lpVaultMint] = deriveInsuranceLpMint(programId, slabPk);

          // Idempotent on retry — a prior attempt may have already landed this ix
          // even though the overall create() call subsequently failed/threw.
          const existingRegistry = await connection.getAccountInfo(lpVaultRegistry);
          if (!existingRegistry) {
            const createLpVaultIx = buildIx({
              programId,
              keys: buildAccountMetas(ACCOUNTS_CREATE_LP_VAULT, {
                admin: wallet.publicKey,
                market: slabPk,
                registry: lpVaultRegistry,
                lpMint: lpVaultMint,
                systemProgram: WELL_KNOWN.systemProgram,
                tokenProgram: WELL_KNOWN.tokenProgram,
              }),
              data: encodeCreateLpVaultV17({
                feeShareBps: 1000, // 10% fee share — matches the 5 seeded markets
                oiReservationThresholdBps: 8000,
                redemptionCooldownSlots: 5n, // fast cooldown for devnet — matches seeded markets
                domain: 0,
              }),
            });

            const sigLpVault = await sendTx({
              connection,
              wallet,
              abortSignal,
              instructions: [createLpVaultIx],
              computeUnits: 250_000,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, sigLpVault] }));
          }
          updateInFlightStep(slabPk.toBase58(), 5);
        }

        // Keeper registration — non-fatal; market is live regardless. MUST run here,
        // BEFORE Step 5 (Stake InitPool) below — not after it as originally written.
        //
        // ROOT CAUSE (confirmed by live end-to-end reproduction): Step 5 rotates
        // on-chain marketauth from this wallet to the stake-pool PDA. keeper-register's
        // H1 auth requires `deployer` (this wallet) to match the slab's LIVE on-chain
        // admin/marketauth. Calling it after Step 5 meant that check compared the
        // creator wallet against the stake-pool PDA — always a mismatch — so every
        // keeper-oracle market failed registration with 403 "Deployer does not match
        // slab admin", permanently (marketauth never rotates back). Registering here,
        // while marketauth is still this wallet (Step 4 already ran; Step 5 hasn't
        // yet), fixes it structurally instead of teaching the route about the stake
        // PDA as a second valid authority.
        //
        // Registers { marketAddress, poolAddress, dexType } with the keeper service so
        // PushAuthMark price-push starts within the next keeper cycle (~30s).
        //
        // BUG FIX (2026-07-09): this used to inline its own sign+POST logic here,
        // duplicated by nothing (there was no retry path). It's now
        // registerMarketWithKeeper() (module scope above) — a single implementation
        // shared with retryKeeperRegistration(), which LaunchSuccess's "Retry
        // registration" button calls when this first attempt fails (see that
        // function's BUG FIX comment for what changed and why: signMessage
        // unavailability and sign failures are now surfaced explicitly instead of
        // silently posting a request with no `signature` field).
        let keeperDelegated = false;
        let keeperMessage: string | null = null;
        if (isKeeperOracle && params.dexPoolAddress) {
          const outcome = await registerMarketWithKeeper(wallet, {
            slabAddress: slabPk.toBase58(),
            mainnetCA: params.mainnetCA,
            dexPoolAddress: params.dexPoolAddress,
            dexType: params.dexType,
            symbol: params.symbol,
          });
          keeperDelegated = outcome.registered;
          keeperMessage = outcome.message;
        }

        // Step 5 (FINAL on-chain step): percolator-stake InitPool. Creates the
        // per-market stake pool and — critically — ROTATES on-chain
        // marketauth from this wallet to the stake-pool PDA
        // (stake-governs-market design; mirrors newmarkets.ts step [7]).
        // This is why Step 4 (Earn vault) above must always complete first,
        // and why this must be the LAST on-chain mutation the wizard
        // performs — nothing after this point may depend on marketauth
        // still being the creator wallet.
        if (startStep <= 5) {
          setState((s) => ({ ...s, step: 5, stepLabel: STEP_LABELS[5] }));

          // Stake pools live under this deployment's vault program
          // (getConfig().vaultProgramId) — NOT the SDK's default stake
          // program id. Same lookup + fallback pattern as
          // hooks/useStakeDeposit.ts and hooks/useStakePool.ts.
          const stakeProgramId = new PublicKey(
            (getConfig() as { vaultProgramId?: string }).vaultProgramId ??
              "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3",
          );
          const [stakePoolPda] = deriveStakePool(slabPk, stakeProgramId);

          // Idempotent on retry — if a prior attempt already landed InitPool,
          // don't try again (a fresh lpMint/vault keypair pair would be
          // orphaned, and InitPool would revert against an already-live pool).
          const existingPool = await connection.getAccountInfo(stakePoolPda);
          if (!existingPool) {
            const [stakeVaultAuth] = deriveStakeVaultAuth(stakePoolPda, stakeProgramId);
            const stakeLpMintKp = Keypair.generate();
            const stakeVaultKp = Keypair.generate();

            const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
            const vaultRent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

            const createLpMintIx = SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: stakeLpMintKp.publicKey,
              lamports: mintRent,
              space: MINT_SIZE,
              programId: WELL_KNOWN.tokenProgram,
            });
            const createVaultIx = SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: stakeVaultKp.publicKey,
              lamports: vaultRent,
              space: ACCOUNT_SIZE,
              programId: WELL_KNOWN.tokenProgram,
            });
            const initPoolIx = buildIx({
              programId: stakeProgramId,
              keys: initPoolAccounts({
                admin: wallet.publicKey,
                slab: slabPk,
                pool: stakePoolPda,
                lpMint: stakeLpMintKp.publicKey,
                vault: stakeVaultKp.publicKey,
                vaultAuth: stakeVaultAuth,
                collateralMint: params.mint,
                percolatorProgram: programId,
              }),
              // cooldown=5 slots, depositCap=0 (uncapped) — matches the 5 seeded markets
              data: encodeStakeInitPool(5n, 0n),
            });

            // UpdateFeeSplit (wrapper tag 86) — MARKETAUTH-GATED, so it MUST land
            // BEFORE initPoolIx (which rotates cfg.marketauth to the pool PDA). Only
            // for a non-default split; validated with the wrapper's own rule.
            const feeSplitArgs = params.feeSplit;
            // v18: UpdateFeeSplit (tag 86) is CAS-bound to asset-0's authority_epoch
            // lane — live-read the current value off the market (this still runs
            // before StakeInitPool rotates marketauth, so the creator gates it).
            const fsSlabInfo = feeSplitArgs ? await connection.getAccountInfo(slabPk) : null;
            const fsAuthorityEpoch = fsSlabInfo?.data
              ? readAssetControlSeqs(new Uint8Array(fsSlabInfo.data), 0).authorityEpoch
              : 0n;
            const updateFeeSplitIx = feeSplitArgs
              ? (() => {
                  const feeSplitV18 = { ...feeSplitArgs, authorityEpoch: fsAuthorityEpoch };
                  const reason = validateFeeSplit(feeSplitV18);
                  if (reason) throw new Error(`Invalid fee split: ${reason}`);
                  return buildIx({
                    programId,
                    keys: buildAccountMetas(ACCOUNTS_UPDATE_FEE_SPLIT, {
                      admin: wallet.publicKey,
                      market: slabPk,
                    }),
                    data: encodeUpdateFeeSplit(feeSplitV18),
                  });
                })()
              : null;
            // BindInsuranceAuthority (stake tag 19) — REQUIRED (staker/insurance leg
            // exit). Runs AFTER initPoolIx; creator still signs as asset-0 insurance
            // authority (InitPool rotates marketauth, not insurance_authority).
            const bindInsuranceIx = buildIx({
              programId: stakeProgramId,
              keys: bindInsuranceAuthorityAccounts({
                admin: wallet.publicKey,
                poolPda: stakePoolPda,
                vaultAuth: stakeVaultAuth,
                slab: slabPk,
                percolatorProgram: programId,
              }),
              data: encodeStakeBindInsuranceAuthority(),
            });

            const sigStake = await sendTx({
              connection,
              wallet,
              abortSignal,
              // Order is load-bearing (see orderStakeTailInstructions): fee split BEFORE
              // InitPool, Bind AFTER InitPool.
              instructions: orderStakeTailInstructions(
                [createLpMintIx, createVaultIx],
                updateFeeSplitIx,
                initPoolIx,
                bindInsuranceIx,
              ),
              signers: [stakeLpMintKp, stakeVaultKp],
              computeUnits: 900_000,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, sigStake] }));
          }
          updateInFlightStep(slabPk.toBase58(), 6);
        }

        // PERC-465: Post-creation hooks — register with oracle keeper + mint devnet token
        const slabAddr = slabPk.toBase58();
        const mintAddr = params.mint.toBase58();
        const isDevnet = getNetwork() === "devnet";

        if (isDevnet && slabAddr) {
          // PERC-465: mainnet_ca is already written to the markets table via /api/markets POST above.
          // The oracle keeper auto-discovers new markets from Supabase every 30s.

          // #2608/#2610: this used to await POST /api/devnet-airdrop here,
          // duplicating the claim the "GET SIM-USDC & TRADE" button on the
          // success screen already makes on click (LaunchSuccess.tsx's
          // handleMintAndTrade) — every failure mode of that duplicate call put
          // an unreportable error banner or a permanently-stuck spinner on the
          // most important screen in the product. Removed: the button beside it
          // does the identical job, and the creator clicks it to reach the trade
          // page anyway, so nothing is lost. Still set devnetMint so that
          // button renders (it's the Sim-USDC collateral mint, not a devnet
          // mirror of `mintAddr` — see LaunchSuccess.tsx's doc comment).
          setState((s) => ({ ...s, devnetMint: mintAddr }));
        }

        // Done! Clear in-memory keypair ref + in-flight recovery state.
        slabKpRef.current = null;
        clearInFlightMarket(slabPk.toBase58());
        setState((s) => ({
          ...s,
          loading: false,
          step: 6,
          stepLabel: "Market created!",
          keeperDelegated,
          keeperMessage,
          // GH#1266: Defensively re-set slabAddress from slabPk at completion to guard
          // against any state-update race where a prior step's address is stale.
          slabAddress: slabPk.toBase58(),
        }));
      } catch (e) {
        const msg = parseMarketCreationError(e);
        setState((s) => ({ ...s, loading: false, error: msg }));
      }
    },
    [connection, wallet, state.slabAddress]
  );

  const reset = useCallback(() => {
    slabKpRef.current = null;
    // PERC-8329: Clear any stale key that may have been stored by old code (defensive cleanup).
    try {
      localStorage.removeItem("percolator-pending-slab-keypair");
    } catch (err) {
      // Storage error - log for debugging but don't block flow
      console.debug('[useCreateMarket] Failed to clear pending keypair from storage:', 
        err instanceof Error ? err.message : String(err)
      );
    }
    setState({
      step: 0,
      stepLabel: "",
      txSigs: [],
      slabAddress: null,
      error: null,
      loading: false,
      batchFallbackReason: null,
      devnetMint: null,
      insuranceMintFailed: false,
      backingSeedFailed: false,
      keeperDelegated: false,
      keeperMessage: null,
      keeperRegistering: false,
      phase: "idle",
      landingIndex: 0,
      landingTotal: 0,
    });
  }, []);

  /**
   * Standalone "Retry registration" entry point for LaunchSuccess (see BUG FIX
   * 2026-07-09 above) — the market is already live on-chain, so this just re-runs
   * the sign+POST keeper-register step without touching the slab or redoing any
   * on-chain instructions. Safe to call repeatedly; the route's upsert is
   * idempotent per slabAddress.
   */
  const retryKeeperRegistration = useCallback(
    async (params: KeeperRegisterRetryParams) => {
      setState((s) => ({ ...s, keeperRegistering: true }));
      // Replay the launch payload when we still have it, so Retry writes the
      // creator's real leverage/fee rather than leaving the column defaults.
      const outcome = await registerMarketWithKeeper(wallet, {
        ...params,
        payload: params.payload ?? launchRegistrationPayloads.get(params.slabAddress) ?? null,
      });
      setState((s) => ({
        ...s,
        keeperRegistering: false,
        keeperDelegated: outcome.registered,
        keeperMessage: outcome.message,
      }));
      return outcome;
    },
    [wallet],
  );

  return { state, create, reset, restoreSlabKeypair, retryKeeperRegistration, cancelInFlightLaunch };
}
