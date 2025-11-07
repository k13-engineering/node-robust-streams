import { sink, type TSinkStream } from "./sink.ts";
import { type TStreamChunk } from "./stream.ts";

type TSyncSinkWriteResult = {
  error: Error;
} | {
  error: undefined;
};

type TSyncSinkFinishResult = {
  error: Error;
} | {
  error: undefined;
};

const syncSink = <T extends TStreamChunk>({
  write: providedWrite,
  finish: providedFinish,
  destroy: providedDestroy
}: {
  write: (args: { chunks: T[] }) => TSyncSinkWriteResult,
  finish: () => TSyncSinkFinishResult,
  destroy: () => void
}) => {

  type C = TSinkStream<T>;

  return sink({
    openSinkStream: ({ backpressure, fail }) => {

      const startTimeoutHandle = setTimeout(() => {
        backpressure({ pressure: 0 });
      }, 0);

      const write: C["write"] = ({ chunks }: { chunks: T[] }) => {
        const { error } = providedWrite({ chunks });
        if (error !== undefined) {
          fail({ error });
          return;
        }
      };

      const finish: C["finish"] = ({ done }: { done: () => void }) => {
        clearTimeout(startTimeoutHandle);

        const { error } = providedFinish();
        if (error !== undefined) {
          fail({ error });
          return;
        }

        done();
      };

      const destroy: C["destroy"] = () => {
        clearTimeout(startTimeoutHandle);
        providedDestroy();
      };

      return {
        write,
        finish,
        destroy
      };
    }
  });
};

export {
  syncSink
};

export type {
  TSyncSinkWriteResult,
  TSyncSinkFinishResult
};
