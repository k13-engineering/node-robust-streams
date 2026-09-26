import type { TSourceStream } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import { syncSource } from "./sync-source.ts";
import type { TSyncSourceStatus } from "./sync-source.ts";

// the statuses a fixed chunks source may yield, while open, it reports how many chunks are left to read
type TFixedChunksSourceStatus = {
  type: "open";
  remainingChunks: number;
} | Exclude<TSyncSourceStatus, { type: "open" }>;

// source handing out the given chunks, at most maxPerTurn of them per read(), and ending afterwards
const fixedChunksSource = <T extends TStreamChunk>({
  chunks: providedChunks,
  maxPerTurn = Infinity
}: {
  chunks: readonly T[];
  maxPerTurn?: number;
}): TSourceStream<T, TFixedChunksSourceStatus> => {
  let remaining = providedChunks;

  const source = syncSource<T>({
    read: () => {
      if (remaining.length === 0) {
        return {
          error: undefined,
          chunks: undefined,
          end: true
        };
      }

      const chunks = remaining.slice(0, maxPerTurn);
      remaining = remaining.slice(chunks.length);

      return {
        error: undefined,
        chunks,
        end: false
      };
    }
  });

  // remainingChunks only changes within read(), polls on an open sync source are triggered right away anyway
  return {
    ...source,
    status: () => {
      const status = source.status();
      return status.type === "open" ? Object.freeze({ type: status.type, remainingChunks: remaining.length }) : status;
    }
  };
};

export type {
  TFixedChunksSourceStatus
};

export {
  fixedChunksSource
};
