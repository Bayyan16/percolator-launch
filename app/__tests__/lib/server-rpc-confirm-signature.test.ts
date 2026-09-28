// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/config', () => ({
  getNetwork: () => 'devnet',
  getRpcEndpoint: () => 'https://api.devnet.solana.com',
}));

import { confirmServerSignature } from '@/lib/server-rpc';

const SIG = 'test-signature';

describe('confirmServerSignature', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the original signature once the RPC reports confirmed', async () => {
    const getSignatureStatus = vi.fn().mockResolvedValue({
      value: { err: null, confirmationStatus: 'confirmed' },
    });
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 5_000 });
    const assertion = expect(pending).resolves.toBe(SIG);

    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;

    expect(getSignatureStatus).toHaveBeenCalledWith(SIG, {
      searchTransactionHistory: true,
    });
  });

  it('rejects an explicit on-chain error', async () => {
    const getSignatureStatus = vi.fn().mockResolvedValue({
      value: {
        err: { InstructionError: [0, 'InvalidArgument'] },
        confirmationStatus: 'confirmed',
      },
    });
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toThrow(/Transaction failed/);

    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
  });

  it('performs a final history re-check before declaring timeout', async () => {
    const getSignatureStatus = vi
      .fn()
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValueOnce({
        value: { err: null, confirmationStatus: 'finalized' },
      });
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 1_000 });
    const assertion = expect(pending).resolves.toBe(SIG);

    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;

    expect(getSignatureStatus).toHaveBeenCalledTimes(2);
  });
  it('fails closed when the signature is still unknown after the final re-check', async () => {
    const getSignatureStatus = vi.fn().mockResolvedValue({ value: null });
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toThrow(/not confirmed within 1000ms/);

    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;

    expect(getSignatureStatus).toHaveBeenCalledTimes(2);
  });
});
