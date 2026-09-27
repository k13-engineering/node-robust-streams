import type { TSourceStream } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import { syncSource } from "./sync-source.ts";
import type { TSyncSourceStatus } from "./sync-source.ts";

// the statuses a fixed chunks source may yield, while open, it reports how many chunks are left to read
type TFixedChunksSourceStatus = TSyncSourceStatus<{ remainingChunks: number }>;

// source handing out the given chunks, at most maxPerTurn of them per read(), and ending afterwards
const fixedChunksSource = <T extends TStreamChunk>({
  chunks: providedChunks,
  maxPerTurn = Infinity
}: {
  chunks: readonly T[];
  maxPerTurn?: number;
}): TSourceStream<T, TFixedChunksSourceStatus> => {
  let remaining = providedChunks;

  return syncSource<T, { remainingChunks: number }>({
    open: () => {
      return { error: undefined, status: { remainingChunks: remaining.length } };
    },
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
        end: false,
        status: { remainingChunks: remaining.length }
      };
    }
  });
};

export type {
  TFixedChunksSourceStatus
};

export {
  fixedChunksSource
};
