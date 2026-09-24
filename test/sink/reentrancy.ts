import assert from "node:assert";

import type { ITestGroup } from "ya-test-library";
import {
  StreamReentrancyError
} from "../../lib/errors.ts";
import { sink } from "../../lib/sink.ts";
import type { TSinkStream, TSinkStreamFactoryOptions } from "../../lib/sink.ts";
import type { TStreamChunk } from "../../lib/stream.ts";

const createDummySinkStream = ({
  streamImpl,
  callbacksImpl
}: {
  streamImpl: Partial<TSinkStream<TStreamChunk>>,
  callbacksImpl: Partial<TSinkStreamFactoryOptions>
}) => {
  let capturedBackpressure: ((args: { pressure: number }) => void) | undefined = undefined;
  let capturedFail: ((args: { error: Error }) => void) | undefined = undefined;

  const sinkFactory = sink({
    openSinkStream: ({ backpressure, fail }) => {
      capturedBackpressure = backpressure;
      capturedFail = fail;

      return {
        write: ({ chunks }) => {
          return streamImpl.write!({ chunks });
        },
        finish: ({ done }) => {
          return streamImpl.finish!({ done });
        },
        destroy: ({ reason }) => {
          return streamImpl.destroy!({ reason });
        },
      };
    }
  });

  const sinkStream = sinkFactory.openSinkStream({
    backpressure: ({ pressure }) => {
      callbacksImpl.backpressure!({ pressure });
    },
    fail: ({ error }) => {
      callbacksImpl.fail!({ error });
    }
  });

  assert.ok(capturedBackpressure !== undefined);
  assert.ok(capturedFail !== undefined);

  return {
    streamApi: sinkStream,
    internalApi: {
      backpressure: capturedBackpressure! as (args: { pressure: number }) => void,
      fail: capturedFail! as (args: { error: Error }) => void,
    }
  };
};

const sinkReentrancyTestGroup: ITestGroup = {
  tests: {
    "should allow [internal task] -> backpressure() -> ... -> write()": () => {
      const sinkStream = createDummySinkStream({
        streamImpl: {
          write: () => {
            return undefined;
          }
        },

        callbacksImpl: {
          backpressure: () => {
            sinkStream.streamApi.write({ chunks: ["1", "2", "3"] });
          }
        }
      });

      sinkStream.internalApi.backpressure({ pressure: 0 });
    },

    "should allow [external task] -> write() -> ... -> backpressure()": () => {
      const sinkStream = createDummySinkStream({
        streamImpl: {
          write: () => {
            sinkStream.internalApi.backpressure({ pressure: 1 });
            return undefined;
          }
        },

        callbacksImpl: {
          backpressure: () => {

          }
        }
      });

      sinkStream.streamApi.write({ chunks: ["1", "2", "3"] });
    },

    "should throw on [external task] -> write() -> ... -> write()": () => {
      const sinkStream = createDummySinkStream({
        streamImpl: {
          write: ({ chunks }) => {
            sinkStream.streamApi.write({ chunks });
            return undefined;
          }
        },

        callbacksImpl: {}
      });

      assert.throws(() => {
        sinkStream.streamApi.write({ chunks: ["1", "2", "3"] });
      }, (ex: Error) => {
        return StreamReentrancyError.isInstance(ex);
      });
    },

    "should throw on [external task] -> write() -> ... -> finish()": () => {
      const sinkStream = createDummySinkStream({
        streamImpl: {
          write: () => {
            sinkStream.streamApi.finish({ done: () => { } });
            return undefined;
          }
        },

        callbacksImpl: {}
      });

      assert.throws(() => {
        sinkStream.streamApi.write({ chunks: ["1", "2", "3"] });
      }, (ex: Error) => {
        return StreamReentrancyError.isInstance(ex);
      });
    },

    "should throw on [internal task] -> backpressure() -> ... -> backpressure()": () => {
      const sinkStream = createDummySinkStream({
        streamImpl: {},

        callbacksImpl: {
          backpressure: () => {
            sinkStream.internalApi.backpressure({ pressure: 1 });
          }
        }
      });

      assert.throws(() => {
        sinkStream.internalApi.backpressure({ pressure: 0 });
      }, (ex: Error) => {
        return StreamReentrancyError.isInstance(ex);
      });
    },
  }
};

export {
  sinkReentrancyTestGroup
};
