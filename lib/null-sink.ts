import type { TStreamChunk } from "./stream-chunk.ts";
import { syncSink } from "./sync-sink.ts";
import type { TSyncSink } from "./sync-sink.ts";

// sink accepting and dropping all chunks
const nullSink = <T extends TStreamChunk>(): TSyncSink<T> => {
  return syncSink<T>({
    write: () => {
      return { error: undefined };
    },

    finish: () => {
      return { error: undefined };
    },

    destroy: () => {
      // nothing to destroy
      return {};
    }
  });
};

export {
  nullSink
};
