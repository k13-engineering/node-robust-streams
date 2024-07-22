import assert from "node:assert";

import { ITestGroup } from "../../../ya-test-library/lib/types.ts";
import { source, ISourceStream, ISourceStreamFactoryOptions } from "../../lib/source.ts";
import {
  StreamResumeDuringNextError,
  StreamCallbackDuringPauseError
} from "../../lib/errors.ts";
import { TStreamChunk } from "../../lib/stream.ts";

const createDummySourceStream = ({
  streamImpl,
  callbacksImpl
}: {
  streamImpl: Partial<ISourceStream<TStreamChunk>>,
  callbacksImpl: Partial<ISourceStreamFactoryOptions<TStreamChunk>>
}) => {
  let capturedNext: ((args: { chunks: TStreamChunk[] }) => void) | undefined = undefined;
  let capturedEnd: (() => void) | undefined = undefined;
  let capturedFail: ((args: { error: Error }) => void) | undefined = undefined;

  const sourceFactory = source({
    open: ({ next, end, fail }) => {
      capturedNext = next;
      capturedEnd = end;
      capturedFail = fail;

      return {
        pause: () => {
          streamImpl.pause!();
        },
        resume: () => {
          streamImpl.resume!();
        },
        destroy: () => {
          streamImpl.destroy!();
        }
      };
    }
  });

  const sourceStream = sourceFactory.open({
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
    "should allow [internal task] -> next() -> ... -> pause()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => { },
          resume: () => { },
        },

        callbacksImpl: {
          next: () => {
            sourceStream.streamApi.pause();
          }
        }
      });

      sourceStream.streamApi.resume();
      sourceStream.internalApi.next({ chunks: ["hello", "world"] });
    },

    "should allow [internal task] -> next() -> ... -> destroy()": () => {
      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => { },
          resume: () => { },
          destroy: () => { }
        },

        callbacksImpl: {
          next: () => {
            sourceStream.streamApi.destroy();
          }
        }
      });

      sourceStream.streamApi.resume();
      sourceStream.internalApi.next({ chunks: ["hello", "world"] });
    },

    "should throw on [any task] -> next() -> ... -> resume()": () => {

      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => { },
          resume: () => { }
        },

        callbacksImpl: {
          next: () => {
            sourceStream.streamApi.resume();
          }
        }
      });

      // must be resumed once in order to emit data
      sourceStream.streamApi.resume();
      sourceStream.streamApi.pause();

      assert.throws(() => {
        sourceStream.internalApi.next({ chunks: ["hello", "world"] });
      }, (ex: Error) => {
        return StreamResumeDuringNextError.isInstance(ex);
      });
    },

    "should throw on [any task] -> pause() -> ... -> next()": () => {

      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => {
            sourceStream.internalApi.next({ chunks: ["hello", "world"] });
          },
          resume: () => { }
        },

        callbacksImpl: {
          next: () => {
          }
        }
      });

      // must be resumed once
      sourceStream.streamApi.resume();

      assert.throws(() => {
        sourceStream.streamApi.pause();
      }, (ex: Error) => {
        return StreamCallbackDuringPauseError.isInstance(ex);
      });
    },

    "should throw on [any task] -> pause() -> ... -> end()": () => {

      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => {
            sourceStream.internalApi.end();
          },
          resume: () => { }
        },

        callbacksImpl: {
          next: () => {
          }
        }
      });

      // must be resumed once
      sourceStream.streamApi.resume();

      assert.throws(() => {
        sourceStream.streamApi.pause();
      }, (ex: Error) => {
        return StreamCallbackDuringPauseError.isInstance(ex);
      });
    },

    "should throw on [any task] -> pause() -> ... -> fail()": () => {

      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => {
            sourceStream.internalApi.fail({ error: new Error("test") });
          },
          resume: () => { }
        },

        callbacksImpl: {
          next: () => {
          }
        }
      });

      // must be resumed once
      sourceStream.streamApi.resume();

      assert.throws(() => {
        sourceStream.streamApi.pause();
      }, (ex: Error) => {
        return StreamCallbackDuringPauseError.isInstance(ex);
      });
    },

    "should allow [external task] --> resume() --> ... --> next() -> ... -> pause()": () => {

      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => { },
          resume: () => {
            sourceStream.internalApi.next({ chunks: ["hello", "world"] });
          },
        },

        callbacksImpl: {
          next: () => {
            sourceStream.streamApi.pause();
          }
        }
      });

      sourceStream.streamApi.resume();
    },

    "should allow [external task] --> resume() --> ... --> next() -> ... -> destroy()": () => {

      const sourceStream = createDummySourceStream({
        streamImpl: {
          pause: () => { },
          resume: () => {
            sourceStream.internalApi.next({ chunks: ["hello", "world"] });
          },
          destroy: () => { }
        },

        callbacksImpl: {
          next: () => {
            sourceStream.streamApi.destroy();
          }
        }
      });

      sourceStream.streamApi.resume();
    }
  }
};

export {
  sourceReentrancyTestGroup
};
