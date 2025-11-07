import { syncSink } from "./sync-sink.ts";
import { type TStreamChunk } from "./stream.ts";

const nullSink = <T extends TStreamChunk>() => {
  return syncSink<T>({
    write: () => {
      // unused

      return { error: undefined };
    },

    finish: () => {
      // unused

      return { error: undefined };
    },

    destroy: () => {
      // unused
    }
  });
};

export {
  nullSink
};
