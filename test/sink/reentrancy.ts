import assert from "node:assert";

import { ITestGroup } from "../../../ya-test-library/lib/types.ts";
import {
  StreamDrainDuringWriteError
} from "../../lib/errors.ts";
import { sink, ISinkStream, ISinkStreamFactoryOptions } from "../../lib/sink.ts";
import { TStreamChunk } from "../../lib/stream.ts";

const createDummySinkStream = ({
  streamImpl,
  callbacksImpl
}: {
  streamImpl: Partial<ISinkStream<TStreamChunk>>,
  callbacksImpl: Partial<ISinkStreamFactoryOptions>
}) => {
  let capturedDrain: (() => void) | undefined = undefined;
  let capturedFail: ((args: { error: Error }) => void) | undefined = undefined;

  const sinkFactory = sink({
    open: ({ drain, fail }) => {
      capturedDrain = drain;
      capturedFail = fail;

      return {
        write: ({ chunks }) => {
          return streamImpl.write!({ chunks });
        },
        finish: ({ done }) => {
          return streamImpl.finish!({ done });
        },
        destroy: () => {
          return streamImpl.destroy!();
        },
      };
    }
  });

  const sinkStream = sinkFactory.open({
    drain: () => {
      callbacksImpl.drain!();
    },
    fail: ({ error }) => {
      callbacksImpl.fail!({ error });
    }
  });

  assert.ok(capturedDrain !== undefined);
  assert.ok(capturedFail !== undefined);

  return {
    streamApi: sinkStream,
    internalApi: {
      drain: capturedDrain! as () => void,
      fail: capturedFail! as (args: { error: Error }) => void,
    }
  };
};

const sinkReentrancyTestGroup: ITestGroup = {
  tests: {
    "should allow [internal task] -> drain() -> ... -> write()": () => {
      const sinkStream = createDummySinkStream({
        streamImpl: {
          write: () => {
            return { takesMore: true };
          }
        },

        callbacksImpl: {
          drain: () => {
            sinkStream.streamApi.write({ chunks: ["1", "2", "3"] });
          }
        }
      });

      sinkStream.internalApi.drain();
    },

    "should throw on [external task] -> write() -> ... -> drain()": () => {
      const sinkStream = createDummySinkStream({
        streamImpl: {
          write: () => {
            sinkStream.internalApi.drain();
            return { takesMore: true };
          }
        },

        callbacksImpl: {
          drain: () => {

          }
        }
      });

      assert.throws(() => {
        sinkStream.streamApi.write({ chunks: ["1", "2", "3"] });
      }, (ex: Error) => {
        return StreamDrainDuringWriteError.isInstance(ex);
      });
    },
  }
};

export {
  sinkReentrancyTestGroup
};
