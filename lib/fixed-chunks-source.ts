import { type TStreamChunk } from "./stream.ts";
import { syncSource } from "./sync-source.ts";

const fixedChunksSource = <T extends TStreamChunk>({
  chunks: providedChunks,
  maxPerTurn = Infinity
}: {
  chunks: T[],
  maxPerTurn?: number
}) => {
  let remaining = providedChunks;

  return syncSource<T>({

    maxPerTurn,

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
    },
  });
};

export {
  fixedChunksSource
};
