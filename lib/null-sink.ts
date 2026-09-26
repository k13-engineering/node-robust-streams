import type { TSinkStream } from "./sink-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import { syncSink } from "./sync-sink.ts";

// sink accepting and dropping all chunks
const nullSink = <T extends TStreamChunk>(): TSinkStream<T> => {
  return syncSink<T>({
    write: () => {
      return { error: undefined };
    },

    finish: () => {
      return { error: undefined };
    },

    destroy: () => {
      // nothing to destroy
    }
  });
};

export {
  nullSink
};
