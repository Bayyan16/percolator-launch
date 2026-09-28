// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  class ServerSignatureExecutionError extends Error {
    readonly signature: string;
    readonly transactionError: unknown;

    constructor(signature: string, transactionError: unknown) {
      super(`Transaction failed: ${JSON.stringify(transactionError)}`);
      this.name = 'ServerSignatureExecutionError';
      this.signature = signature;
      this.transactionError = transactionError;
    }
  }

  class ServerSignatureTimeoutError extends Error {
    readonly signature: string;
    readonly timeoutMs: number;

    constructor(signature: string, timeoutMs: number) {
      super(`Transaction ${signature} not confirmed within ${timeoutMs}ms`);
      this.name = 'ServerSignatureTimeoutError';
      this.signature = signature;
      this.timeoutMs = timeoutMs;
    }
  }

  return {
    ServerSignatureExecutionError,
    ServerSignatureTimeoutError,
    confirmServerSignature: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    getAccount: vi.fn(),
    getAssociatedTokenAddress: vi.fn(),
    getDevnetMintSigner: vi.fn(),
    tryFaucetGate: vi.fn(),
    releaseFaucetClaim: vi.fn(),
    captureException: vi.fn(),
    checkFundRateLimit: vi.fn(),
    getClientIp: vi.fn(),
    serviceClient: { marker: 'service-client' },
  };
});

vi.mock('@/lib/config', () => ({
  getNetwork: () => 'devnet',
  getRpcEndpoint: () => 'https://api.devnet.solana.com',
}));

vi.mock('@/lib/get-client-ip', () => ({
  getClientIp: mocks.getClientIp,
}));

vi.mock('@/lib/fund-ip-rate-limit', () => ({
  checkFundRateLimit: mocks.checkFundRateLimit,
}));

vi.mock('@/lib/server-rpc', () => ({
  confirmServerSignature: mocks.confirmServerSignature,
  getServerConnection: () => ({
    getLatestBlockhash: mocks.getLatestBlockhash,
    sendRawTransaction: mocks.sendRawTransaction,
  }),
  ServerSignatureExecutionError: mocks.ServerSignatureExecutionError,
  ServerSignatureTimeoutError: mocks.ServerSignatureTimeoutError,
}));

vi.mock('@/lib/devnet-signer', () => ({
  getDevnetMintSigner: mocks.getDevnetMintSigner,
}));

vi.mock('@/lib/supabase', () => ({
  getServiceClient: () => mocks.serviceClient,
}));

vi.mock('@/lib/faucet-rate-gate', () => ({
  tryFaucetGate: mocks.tryFaucetGate,
  releaseFaucetClaim: mocks.releaseFaucetClaim,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mocks.captureException,
}));

vi.mock('@/lib/transaction-confirmation', () => ({
  assertSuccessfulConfirmation: vi.fn(),
}));

vi.mock('@solana/web3.js', () => {
  class PublicKey {
    constructor(private readonly value: unknown) {}

    toBase58(): string {
      return String(this.value);
    }
  }

  class Transaction {
    recentBlockhash?: string;
    feePayer?: PublicKey;

    add(): this {
      return this;
    }

    serialize(): Buffer {
      return Buffer.from([]);
    }
  }

  class Connection {}

  return {
    Connection,
    PublicKey,
    Transaction,
    LAMPORTS_PER_SOL: 1_000_000_000,
  };
});

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: mocks.getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction: vi.fn(),
  createMintToInstruction: vi.fn(),
  getAccount: mocks.getAccount,
  TOKEN_PROGRAM_ID: { toBase58: () => 'TokenProgram111' },
}));

function requestFor(wallet: string): NextRequest {
  return new NextRequest('http://localhost/api/playground/faucet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = 'devnet';
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;

  mocks.getClientIp.mockReturnValue('203.0.113.10');
  mocks.checkFundRateLimit.mockResolvedValue({
    allowed: true,
    retryAfter: 0,
  });

  mocks.tryFaucetGate.mockResolvedValue({
    allowed: true,
    nextClaimAt: null,
    claimId: 77,
  });
  mocks.releaseFaucetClaim.mockResolvedValue(undefined);

  mocks.getDevnetMintSigner.mockReturnValue({
    publicKey: () => 'MintAuthority1111111111111111111111111111',
    signTransaction: (tx: unknown) => tx,
  });

  mocks.getAssociatedTokenAddress.mockResolvedValue({
    toBase58: () => 'Ata111111111111111111111111111111111111',
  });
  mocks.getAccount.mockResolvedValue({});

  mocks.getLatestBlockhash.mockResolvedValue({
    blockhash: 'finalized-blockhash',
  });
  mocks.sendRawTransaction.mockResolvedValue('original-usdc-signature');
  mocks.confirmServerSignature.mockResolvedValue('original-usdc-signature');
});

describe('POST /api/playground/faucet claim safety after broadcast', () => {
  it('keeps the claim reserved on explicit confirmation timeout', async () => {
    mocks.confirmServerSignature.mockRejectedValueOnce(
      new mocks.ServerSignatureTimeoutError('original-usdc-signature', 45_000),
    );

    const { POST } = await import('@/app/api/playground/faucet/route');
    const response = await POST(requestFor('WalletTimeout1111111111111111111111111111'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.pending).toBe(true);
    expect(body.retryable).toBe(false);
    expect(body.usdc_sig).toBe('original-usdc-signature');
    expect(body.nextClaimAt).toEqual(expect.any(String));
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it('also fails closed on an unexpected error after a signature exists', async () => {
    mocks.confirmServerSignature.mockRejectedValueOnce(
      new TypeError('unexpected RPC response shape'),
    );

    const { POST } = await import('@/app/api/playground/faucet/route');
    const response = await POST(requestFor('WalletUnexpected1111111111111111111111111'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.pending).toBe(true);
    expect(body.retryable).toBe(false);
    expect(body.usdc_sig).toBe('original-usdc-signature');
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it('releases the claim when on-chain execution failure is established', async () => {
    const txError = { InstructionError: [0, 'InvalidArgument'] };
    mocks.confirmServerSignature.mockRejectedValueOnce(
      new mocks.ServerSignatureExecutionError(
        'original-usdc-signature',
        txError,
      ),
    );

    const { POST } = await import('@/app/api/playground/faucet/route');
    const response = await POST(requestFor('WalletFailed111111111111111111111111111111'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.pending).not.toBe(true);
    expect(body.retryable).toBe(true);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(
      mocks.serviceClient,
      77,
    );
  });

  it('releases the claim for a failure before any signature is issued', async () => {
    mocks.sendRawTransaction.mockRejectedValueOnce(
      new Error('preflight rejected'),
    );

    const { POST } = await import('@/app/api/playground/faucet/route');
    const response = await POST(requestFor('WalletPrewire11111111111111111111111111111'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.pending).not.toBe(true);
    expect(body.retryable).toBe(true);
    expect(mocks.confirmServerSignature).not.toHaveBeenCalled();
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledTimes(1);
  });
});
