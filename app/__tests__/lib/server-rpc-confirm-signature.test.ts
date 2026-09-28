// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/config', () => ({
  getNetwork: () => 'devnet',
  getRpcEndpoint: () => 'https://api.devnet.solana.com',
}));

import {
  confirmServerSignature,
  ServerSignatureExecutionError,
  ServerSignatureTimeoutError,
} from '@/lib/server-rpc';

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

  it('rejects an explicit on-chain error from the polling phase', async () => {
    const txError = { InstructionError: [0, 'InvalidArgument'] };
    const getSignatureStatus = vi.fn().mockResolvedValue({
      value: {
        err: txError,
        confirmationStatus: 'confirmed',
      },
    });
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ServerSignatureExecutionError',
      signature: SIG,
      transactionError: txError,
    });

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

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 2_000 });
    const assertion = expect(pending).resolves.toBe(SIG);

    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    expect(getSignatureStatus).toHaveBeenCalledTimes(2);
  });

  it('reports an on-chain error discovered by the final status check', async () => {
    const txError = { InstructionError: [1, 'Custom'] };
    const getSignatureStatus = vi
      .fn()
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValueOnce({
        value: { err: txError, confirmationStatus: 'confirmed' },
      });
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 2_000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ServerSignatureExecutionError,
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('fails closed with an unresolved-outcome error when status stays unknown', async () => {
    const getSignatureStatus = vi.fn().mockResolvedValue({ value: null });
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 2_000 });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ServerSignatureTimeoutError',
      signature: SIG,
      timeoutMs: 2_000,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('bounds stalled polling requests and the final history re-check', async () => {
    const getSignatureStatus = vi.fn(
      () => new Promise(() => {}),
    );
    const connection = { getSignatureStatus } as any;

    const pending = confirmServerSignature(connection, SIG, { timeoutMs: 7_000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ServerSignatureTimeoutError,
    );

    // 1.5s initial sleep + 5s bounded poll + 1.5s loop sleep +
    // 2s bounded final check = <= 10s total under fake timers.
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(getSignatureStatus).toHaveBeenCalledTimes(2);
  });
});
