import assert from "node:assert";

import type { ITestGroup } from "ya-test-library";
import { source } from "../../lib/source.ts";
import type { TSourceStream, TSourceStreamFactoryOptions } from "../../lib/source.ts";
import {
  StreamCallbackDuringBackpressureError,
  StreamReentrancyError
} from "../../lib/errors.ts";
import type { TStreamChunk } from "../../lib/stream.ts";

const createDummySourceStream = ({
  streamImpl,
  callbacksImpl
}: {
  streamImpl: Partial<TSourceStream>,
  callbacksImpl: Partial<TSourceStreamFactoryOptions<TStreamChunk>>
}) => {
  let capturedNext: ((args: { chunks: TStreamChunk[] }) => void) | undefined = undefined;
  let capturedEnd: (() => void) | undefined = undefined;
  let capturedFail: ((args: { error: Error }) => void) | undefined = undefined;

  const sourceFactory = source({
    openSourceStream: ({ next, end, fail }) => {
      capturedNext = next;
      capturedEnd = end;
      capturedFail = fail;

      return {
        backpressure: ({ pressure }) => {
          streamImpl.backpressure!({ pressure });
        },
        destroy: () => {
          streamImpl.destroy!();
        }
      };
    }
  });

  const sourceStream = sourceFactory.openSourceStream({
    next: ({ chunks }) => {
      callbacksImpl.next!({ chunks });
    },
    end: () => {
      callbacksImpl.end!();
    },
    fail: ({ error }) => {
      callbacksImpl.fail!({ error });
    }
  });

  assert.ok(capturedNext !== undefined);
  assert.ok(capturedEnd !== undefined);
  assert.ok(capturedFail !== undefined);

  return {
    streamApi: sourceStream,
    internalApi: {
      next: capturedNext! as (args: { chunks: TStreamChunk[] }) => void,
      end: capturedEnd! as () => void,
      fail: capturedFail! as (args: { error: Error }) => void,
    }
  };
};

const sourceReentrancyTestGroup: ITestGroup = {
  tests: {
    "should allow [internal task] -> next() -> ... -> backpressure()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          backpressure: () => { },
        },

        callbacksImpl: {
          next: () => {
            sourceStream.streamApi.backpressure({ pressure: 1 });
          }
        }
      });

      sourceStream.internalApi.next({ chunks: ["hello", "world"] });
    },

    "should allow [internal task] -> next() -> ... -> destroy()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          destroy: () => { }
        },

        callbacksImpl: {
          next: () => {
            sourceStream.streamApi.destroy();
          }
        }
      });

      sourceStream.internalApi.next({ chunks: ["hello", "world"] });
    },

    "should throw on [any task] -> next() -> ... -> next()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {},

        callbacksImpl: {
          next: () => {
            sourceStream.internalApi.next({ chunks: ["again"] });
          }
        }
      });

      assert.throws(() => {
        sourceStream.internalApi.next({ chunks: ["hello", "world"] });
      }, (ex: Error) => {
        return StreamReentrancyError.isInstance(ex);
      });
    },

    "should throw on [any task] -> next() -> ... -> end()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {},

        callbacksImpl: {
          next: () => {
            sourceStream.internalApi.end();
          }
        }
      });

      assert.throws(() => {
        sourceStream.internalApi.next({ chunks: ["hello", "world"] });
      }, (ex: Error) => {
        return StreamReentrancyError.isInstance(ex);
      });
    },

    "should throw on [any task] -> next() -> ... -> fail()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {},

        callbacksImpl: {
          next: () => {
            sourceStream.internalApi.fail({ error: Error("test") });
          }
        }
      });

      assert.throws(() => {
        sourceStream.internalApi.next({ chunks: ["hello", "world"] });
      }, (ex: Error) => {
        return StreamReentrancyError.isInstance(ex);
      });
    },

    "should throw on [external task] -> backpressure() -> ... -> next()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          backpressure: () => {
            sourceStream.internalApi.next({ chunks: ["hello", "world"] });
          }
        },

        callbacksImpl: {
          next: () => {
          }
        }
      });

      assert.throws(() => {
        sourceStream.streamApi.backpressure({ pressure: 0 });
      }, (ex: Error) => {
        return StreamCallbackDuringBackpressureError.isInstance(ex);
      });
    },

    "should throw on [external task] -> backpressure() -> ... -> end()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          backpressure: () => {
            sourceStream.internalApi.end();
          }
        },

        callbacksImpl: {
          end: () => {
          }
        }
      });

      assert.throws(() => {
        sourceStream.streamApi.backpressure({ pressure: 0 });
      }, (ex: Error) => {
        return StreamCallbackDuringBackpressureError.isInstance(ex);
      });
    },

    "should throw on [external task] -> backpressure() -> ... -> fail()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          backpressure: () => {
            sourceStream.internalApi.fail({ error: Error("test") });
          }
        },

        callbacksImpl: {
          fail: () => {
          }
        }
      });

      assert.throws(() => {
        sourceStream.streamApi.backpressure({ pressure: 0 });
      }, (ex: Error) => {
        return StreamCallbackDuringBackpressureError.isInstance(ex);
      });
    },

    "should throw on [external task] -> backpressure() -> ... -> backpressure()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          backpressure: () => {
            sourceStream.streamApi.backpressure({ pressure: 1 });
          }
        },

        callbacksImpl: {}
      });

      assert.throws(() => {
        sourceStream.streamApi.backpressure({ pressure: 0 });
      }, (ex: Error) => {
        return StreamReentrancyError.isInstance(ex);
      });
    }
  }
};

export {
  sourceReentrancyTestGroup
};
