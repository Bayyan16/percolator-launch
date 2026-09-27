"use client";

import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

const SLOT_POLL_MS = 10_000;

let sharedSlot: bigint | null = null;
let listeners: Set<(slot: bigint) => void> | null = null;
let disposer: (() => void) | null = null;

function subscribeSharedSlot(
  connection: Connection,
  listener: (slot: bigint) => void,
): () => void {
  if (listeners === null) {
    listeners = new Set();
  }

  listeners.add(listener);

  // Replay the latest known slot immediately to new subscribers.
  if (sharedSlot !== null) {
    listener(sharedSlot);
  }

  if (disposer === null) {
    const poll = () => {
      connection
        .getSlot("confirmed")
        .then((slot) => {
          sharedSlot = BigInt(slot);
          listeners?.forEach((cb) => cb(sharedSlot!));
        })
        .catch(() => {
          // Keep the last known slot on a transient RPC failure.
        });
    };

    poll();
    disposer = pollWhenVisible(poll, SLOT_POLL_MS);
  }

  return () => {
    listeners?.delete(listener);

    if (listeners?.size === 0 && disposer !== null) {
      disposer();
      disposer = null;
      sharedSlot = null;
    }
  };
}

/**
 * Live cluster slot shared across all consumers.
 *
 * Refcounted so useEngineFreshness and useOracleFreshness do not create
 * duplicate getSlot() pollers for the same value.
 */
export function useClusterSlot(): bigint | null {
  const { connection } = useConnectionCompat();
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(sharedSlot);

  useEffect(
    () => subscribeSharedSlot(connection, setCurrentSlot),
    [connection],
  );

  return currentSlot;
}
