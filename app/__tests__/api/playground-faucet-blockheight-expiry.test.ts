/**
 * GH#2598 — the Playground USDC faucet must not bind post-broadcast
 * confirmation to lastValidBlockHeight on the load-balanced devnet RPC.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROUTE = path.resolve(__dirname, '../../app/api/playground/faucet/route.ts');
const SERVER_RPC = path.resolve(__dirname, '../../lib/server-rpc.ts');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function usdcMintSection(src: string): string {
  const start = src.indexOf('// ── Mint Sim-USDC');
  const end = src.indexOf('// Record claim AFTER on-chain success');

  expect(start, 'USDC mint section marker moved or disappeared').toBeGreaterThanOrEqual(0);
  expect(end, 'claim marker moved or disappeared').toBeGreaterThan(start);

  return src.slice(start, end);
}

describe('GH#2598: playground faucet blockheight-expiry regression', () => {
  it('uses shared signature-status confirmation instead of blockheight-bound confirmTransaction', () => {
    const route = read(ROUTE);
    const section = usdcMintSection(route);

    expect(route).toMatch(
      /import\s*\{\s*confirmServerSignature\s*,\s*getServerConnection\s*\}\s*from\s*['"]@\/lib\/server-rpc['"]/,
    );
    expect(section).toMatch(/getLatestBlockhash\(\s*['"]finalized['"]\s*\)/);
    expect(section).not.toMatch(/getLatestBlockhash\(\s*['"]confirmed['"]\s*\)/);
    expect(section).not.toContain('lastValidBlockHeight');
    expect(section).not.toContain('confirmTransaction(');
    expect(section).toMatch(
      /confirmServerSignature\(\s*connection,\s*usdcSig,\s*\{\s*timeoutMs:\s*45_000\s*\}\s*\)/,
    );
  });

  it('does not broaden the fix into unrelated faucet broadcast-policy changes', () => {
    const section = usdcMintSection(read(ROUTE));

    expect(section).toContain('sendRawTransaction(');
    expect(section).toMatch(/skipPreflight:\s*false/);
    expect(section).not.toMatch(/maxRetries\s*:/);
  });

  it('the shared helper polls the original signature, never broadcasts, and the existing server sender delegates to it', () => {
    const helper = read(SERVER_RPC);

    const start = helper.indexOf('export async function confirmServerSignature(');
    const end = helper.indexOf('export async function sendAndConfirmServerTx(');

    expect(start, 'confirmServerSignature() missing').toBeGreaterThanOrEqual(0);

    expect(
      end,
      'sendAndConfirmServerTx() missing or appears before confirmServerSignature()',
    ).toBeGreaterThan(start);

    const section = helper.slice(start, end);

    expect(section).toContain('getSignatureStatus(');
    expect(section).toContain('searchTransactionHistory: true');
    expect(section).toMatch(/confirmationStatus\s*===\s*['"]confirmed['"]/);
    expect(section).toMatch(/confirmationStatus\s*===\s*['"]finalized['"]/);
    expect(section).not.toContain('sendRawTransaction(');

    expect(helper).toContain('return confirmServerSignature(connection, sig, { timeoutMs });');
  });
});
