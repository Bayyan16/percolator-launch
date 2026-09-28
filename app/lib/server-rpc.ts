import { Connection, Transaction, type Commitment, type Signer } from "@solana/web3.js";
import { getNetwork, getRpcEndpoint } from "./config";

/**
 * Server-side Solana Connection for API routes.
 *
 * ROOT CAUSE this fixes: server routes used `new Connection(getRpcEndpoint())`,
 * which builds the URL from `HELIUS_DEVNET_API_KEY`. That key is exhausted
 * (HTTP 429 "max usage reached"), so every server-side devnet RPC read failed —
 * surfacing to users as "Could not verify mint authority due to RPC error"
 * (faucet) and "Keeper co-sign failed (500): Failed to build co-sign tx"
 * (market-create step 2).
 *
 * The working devnet endpoint is `DEVNET_RPC_URL` — the SAME full-URL override
 * the `/api/rpc` proxy uses (route.ts). It is Origin-restricted: it returns 401
 * "Unauthorized" without the `Origin: <RPC_UPSTREAM_ORIGIN>` header
 * (default `https://trade.padre.gg`). A raw `new Connection(url)` never sends
 * that header. This helper adds it — harmless for public/unrestricted endpoints —
 * and prefers the full-URL override, mirroring `/api/rpc` exactly, then falls
 * back to `getRpcEndpoint()` / public devnet.
 *
 * SERVER-ONLY: reads `process.env.DEVNET_RPC_URL` / `RPC_UPSTREAM_ORIGIN`, which
 * are undefined in the browser. Client code must keep using the `/api/rpc` proxy.
 */
export function getServerConnection(commitment: Commitment = "confirmed"): Connection {
  const net = getNetwork();
  const override = (
    net === "mainnet" ? process.env.MAINNET_RPC_URL : process.env.DEVNET_RPC_URL
  )?.trim();
  const url = override && /^https?:\/\//.test(override) ? override : getRpcEndpoint();
  const origin =
    (process.env.RPC_UPSTREAM_ORIGIN ?? "").trim() ||
    (net === "devnet" ? "https://trade.padre.gg" : "");
  return new Connection(url, {
    commitment,
    ...(origin ? { httpHeaders: { Origin: origin } } : {}),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isBlockhashMiss(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes("blockhashnotfound") || m.includes("blockhash not found");
}


/**
 * Confirm an already-broadcast server transaction by polling its signature.
 *
 * Unlike blockheight-bound confirmTransaction(), this resolves the original
 * signature independently of the blockhash lifetime. On a load-balanced RPC,
 * a landed transaction can be slow to become visible to the node handling
 * confirmation.
 *
 * This helper never re-sends the transaction.
 */
export async function confirmServerSignature(
  connection: Connection,
  sig: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(1500);
    let status;
    try {
      status = (
        await connection.getSignatureStatus(sig, {
          searchTransactionHistory: true,
        })
      ).value;
    } catch {
      continue;
    }

    if (!status) continue;
    if (status.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
    ) {
      return sig;
    }
  }

  // Final re-check — the RPC can be slow to reflect a landed transaction.
  const finalStatus = await connection
    .getSignatureStatus(sig, { searchTransactionHistory: true })
    .catch(() => ({ value: null as null }));

  const status = finalStatus.value;
  if (
    status &&
    !status.err &&
    (status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized")
  ) {
    return sig;
  }

  throw new Error(`Transaction ${sig} not confirmed within ${timeoutMs}ms`);
}

/**
 * Robust server-side send+confirm for a legacy Transaction on a load-balanced
 * devnet RPC (the padre endpoint). Web3.js `sendAndConfirmTransaction` throws
 * "BlockhashNotFound" (a node behind the LB hasn't propagated the just-fetched
 * blockhash) and "block height exceeded" (slow confirm) even when the tx lands —
 * which surfaced to users as a 500 "Internal server error" on the create-market
 * pre-fund / sim-USDC-claim step.
 *
 * Mitigations: (1) fetch a FINALIZED blockhash (seen by every LB node) so the
 * send/preflight can't miss it; (2) `skipPreflight` by default — these are
 * server-signed, trusted txs, and the send-node preflight is the main
 * BlockhashNotFound source; (3) confirm by POLLING the signature status (not
 * blockhash-tied `confirmTransaction`), so a slow-but-landed tx is reported as
 * success instead of a false failure; (4) retry ONLY on a pre-wire send-time
 * blockhash miss — never re-send after the tx is on the wire, to avoid a
 * double-mint. Throws only when the tx genuinely did not confirm.
 */
export async function sendAndConfirmServerTx(
  connection: Connection,
  tx: Transaction,
  signers: Signer[],
  opts: { maxSendAttempts?: number; timeoutMs?: number; skipPreflight?: boolean } = {},
): Promise<string> {
  const maxSendAttempts = opts.maxSendAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const skipPreflight = opts.skipPreflight ?? true;

  let sig: string | undefined;
  for (let attempt = 0; attempt < maxSendAttempts && !sig; attempt++) {
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = tx.feePayer ?? signers[0].publicKey;
    tx.signatures = [];
    tx.sign(...signers);
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 5 });
    } catch (e) {
      if (isBlockhashMiss(e) && attempt < maxSendAttempts - 1) {
        await sleep(1200);
        continue;
      }
      throw e;
    }
  }
  if (!sig) throw new Error("sendAndConfirmServerTx: transaction was never broadcast");

  return confirmServerSignature(connection, sig, { timeoutMs });
}
