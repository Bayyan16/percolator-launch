// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  UpstreamPool,
  UpstreamUnavailableError,
  CLUSTER_GENESIS,
  buildUpstreams,
} from "@/lib/rpc-upstreams";

const DEV = "https://primary-dev.invalid/rpc";
const MAIN = "https://primary-main.invalid/rpc";
const FB = "https://shared-fallback.invalid/rpc";

const REQ = {
  jsonrpc: "2.0",
  id: 1,
  method: "getSlot",
  params: [],
};

type Network = "devnet" | "mainnet";

function upstreams(network: Network) {
  const env = network === "devnet"
    ? { DEVNET_RPC_FALLBACK_URLS: FB }
    : { MAINNET_RPC_FALLBACK_URLS: FB };

  return buildUpstreams(
    network,
    {
      url: network === "devnet" ? DEV : MAIN,
      headers: { "Content-Type": "application/json" },
    },
    env as NodeJS.ProcessEnv,
  );
}

function setup() {
  const calls: Array<{ url: string; method: string }> = [];

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const req = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };

    calls.push({ url, method: req.method });

    if (url === DEV || url === MAIN) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32429, message: "rate limited" },
        }),
        { status: 429 },
      );
    }

    if (url !== FB) throw new Error("Unexpected mock URL");

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: req.method === "getGenesisHash"
          ? CLUSTER_GENESIS.devnet
          : "DEVNET_ONLY",
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  return {
    pool: new UpstreamPool({
      fetchImpl,
      warn: () => undefined,
    }),
    calls,
  };
}

describe("RPC cluster cache isolation audit", () => {
  it("control: valid devnet fallback is accepted", async () => {
    const { pool } = setup();

    await expect(
      pool.post(upstreams("devnet"), REQ, "devnet"),
    ).resolves.toMatchObject({
      result: "DEVNET_ONLY",
    });
  });

  it("control: fresh mainnet pool rejects devnet fallback", async () => {
    const { pool, calls } = setup();

    await expect(
      pool.post(upstreams("mainnet"), REQ, "mainnet"),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);

    expect(
      calls.filter(c =>
        c.url === FB && c.method === "getSlot"
      ),
    ).toHaveLength(0);
  });

  it("regression: cached devnet verdict must not authorize mainnet", async () => {
    const { pool, calls } = setup();

    await expect(
      pool.post(upstreams("devnet"), REQ, "devnet"),
    ).resolves.toMatchObject({
      result: "DEVNET_ONLY",
    });

    await expect(
      pool.post(upstreams("mainnet"), REQ, "mainnet"),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);

    expect(
      calls.filter(c =>
        c.url === FB && c.method === "getGenesisHash"
      ),
    ).toHaveLength(2);
  });
});

describe("RPC cross-network cache additional controls", () => {
  it("reverse order: mainnet rejection cannot poison valid devnet", async () => {
    const { pool, calls } = setup();

    await expect(
      pool.post(upstreams("mainnet"), REQ, "mainnet"),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);

    await expect(
      pool.post(upstreams("devnet"), REQ, "devnet"),
    ).resolves.toMatchObject({
      result: "DEVNET_ONLY",
    });

    expect(calls.filter(c =>
      c.url === FB && c.method === "getGenesisHash"
    )).toHaveLength(2);

    expect(calls.filter(c =>
      c.url === FB && c.method === "getSlot"
    )).toHaveLength(1);
  });

  it("concurrent probes for the same URL stay network-isolated", async () => {
    const calls: Array<{ url: string; method: string }> = [];

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };

      calls.push({ url, method: body.method });

      if (url === DEV || url === MAIN) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32429, message: "rate limited" },
        }, { status: 429 });
      }

      if (url !== FB) throw new Error("Unexpected mock URL");

      if (body.method === "getGenesisHash") {
        await gate;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: CLUSTER_GENESIS.devnet,
        });
      }

      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: "DEVNET_ONLY",
      });
    }) as typeof fetch;

    const pool = new UpstreamPool({
      fetchImpl,
      warn: () => undefined,
    });

    const requests = [
      pool.post(upstreams("devnet"), REQ, "devnet"),
      pool.post(upstreams("mainnet"), REQ, "mainnet"),
    ];

    const genesisCount = () => calls.filter(c =>
      c.url === FB && c.method === "getGenesisHash"
    ).length;

    // Keep both probes pending before releasing the responses.
    for (let i = 0; i < 200 && genesisCount() < 2; i++) {
      await new Promise<void>(r => setTimeout(r, 10));
    }

    const countBeforeRelease = genesisCount();
    release();

    const results = await Promise.allSettled(requests);

    expect(countBeforeRelease).toBe(2);
    expect(results[0].status).toBe("fulfilled");
    if (results[0].status === "fulfilled") {
      expect(results[0].value).toMatchObject({
        result: "DEVNET_ONLY",
      });
    }

    expect(results[1].status).toBe("rejected");
    if (results[1].status === "rejected") {
      expect(results[1].reason).toBeInstanceOf(
        UpstreamUnavailableError,
      );
    }

    expect(calls.filter(c =>
      c.url === FB && c.method === "getSlot"
    )).toHaveLength(1);
  });
});
