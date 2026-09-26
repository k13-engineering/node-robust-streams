import type { TSourceStream } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import { syncSource } from "./sync-source.ts";

// source handing out the given chunks, at most maxPerTurn of them per read(), and ending afterwards
const fixedChunksSource = <T extends TStreamChunk>({
  chunks: providedChunks,
  maxPerTurn = Infinity
}: {
  chunks: readonly T[];
  maxPerTurn?: number;
}): TSourceStream<T> => {
  let remaining = providedChunks;

  return syncSource<T>({
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
};

export {
  fixedChunksSource
};
