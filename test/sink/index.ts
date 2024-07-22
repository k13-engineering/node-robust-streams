import assert from "node:assert";

import { ITestGroup } from "ya-test-library";

import { sink } from "../../lib/sink.ts";
import {
  StreamAlreadyDestroyedError,
  StreamAlreadyFailedError,
  StreamAlreadyFinishedError,
  StreamAlreadyFinishingError
} from "../../lib/errors.ts";
import { sinkReentrancyTestGroup } from "./reentrancy.ts";

const createDummySinkStream = () => {
  let capturedDrain: (() => void) | undefined = undefined;
  let capturedFail: ((args: { error: Error }) => void) | undefined = undefined;
  let capturedDone: (() => void) | undefined = undefined;

  const sinkFactory = sink({
    open: ({ drain, fail }) => {
      capturedDrain = drain;
      capturedFail = fail;

      return {
        write: () => {
          return {
            takesMore: true
          };
        },
        finish: ({ done }) => {
          capturedDone = done;
        },
        destroy: () => { },
      };
    }
  });

  let state = {
    calls: {
      drain: [] as undefined[],
      fail: [] as { error: Error }[],
    }
  };

  const sinkStream = sinkFactory.open({
    drain: () => {
      state = {
        ...state,
        calls: {
          ...state.calls,
          drain: [
            ...state.calls.drain,
            undefined
          ]
        }
      };
    },
    fail: ({ error }) => {
      state = {
        ...state,
        calls: {
          ...state.calls,
          fail: [
            ...state.calls.fail,
            { error }
          ]
        }
      };
    }
  });

  const done = () => {
    capturedDone!();
  };

  assert.ok(capturedDrain !== undefined);
  assert.ok(capturedFail !== undefined);

  return {
    sinkStream,

    drain: capturedDrain! as () => void,
    fail: capturedFail! as (args: { error: Error }) => void,

    done,

    state: () => state
  };
};

const createDummySinkStreamInStreamingState = () => {

  const {
    sinkStream,
    drain,
    fail,
    state
  } = createDummySinkStream();

  return {
    sinkStream,

    drain,
    fail,

    state,
  };
};

const createDummySinkStreamInDestroyedState = () => {

  const {
    sinkStream,
    drain,
    fail,
    state
  } = createDummySinkStream();

  sinkStream.destroy();

  return {
    sinkStream,

    drain,
    fail,

    state,
  };
};

const createDummySinkStreamInFinishingState = () => {
  const {
    sinkStream,
    drain,
    fail,
    state
  } = createDummySinkStream();

  sinkStream.finish({ done: () => { } });

  return {
    sinkStream,

    drain,
    fail,

    state
  };
};

const createDummySinkStreamInFinishedState = () => {
  const {
    sinkStream,
    drain,
    fail,

    done,

    state
  } = createDummySinkStream();

  sinkStream.finish({ done: () => { } });
  done();

  return {
    sinkStream,

    drain,
    fail,

    state: () => {
      const s = state();

      return {
        ...s,
        calls: {
          ...s.calls,
          drain: s.calls.drain.slice(1)
        }
      };
    },
  };
};

const createDummySinkStreamInFailedState = () => {
  const {
    sinkStream,
    drain,
    fail,
    state
  } = createDummySinkStream();

  fail({ error: Error("test error") });

  return {
    sinkStream,

    drain,
    fail,

    state: () => {
      const s = state();

      return {
        ...s,
        calls: {
          ...s.calls,
          fail: s.calls.fail.slice(1)
        }
      };
    },
  };
};

// [inside] next
// [inside] end
// [inside] fail

// [outside] pause
// [outside] resume
// [outside] destroy

const sinkTestGroup: ITestGroup = {
  groups: {

    "streaming state": {
      tests: {
        "should support write": () => {
          const { sinkStream } = createDummySinkStreamInStreamingState();

          const testChunks = ["abc", "def", "ghi"];

          sinkStream.write({ chunks: testChunks });
        },

        "should support finish": () => {
          const { sinkStream } = createDummySinkStreamInStreamingState();

          sinkStream.finish({ done: () => { } });
        },

        "should support fail": () => {
          const { fail, state } = createDummySinkStreamInStreamingState();

          const testError = Error("test error");

          fail({ error: testError });

          assert.deepStrictEqual(state(), {
            calls: {
              drain: [],
              fail: [
                { error: testError }
              ]
            }
          });
        },

        "should support destroy": () => {
          const { sinkStream } = createDummySinkStreamInStreamingState();
          sinkStream.destroy();
        },
      }
    },

    "finishing state": {
      tests: {
        "should throw when write is called": () => {
          const { sinkStream } = createDummySinkStreamInFinishingState();

          assert.throws(() => {
            sinkStream.write({ chunks: ["abc"] });
          }, (ex: Error) => {
            return StreamAlreadyFinishingError.isInstance(ex);
          });
        },

        "should throw when finish is called": () => {
          const { sinkStream } = createDummySinkStreamInFinishingState();

          assert.throws(() => {
            sinkStream.finish({ done: () => { } });
          }, (ex: Error) => {
            return StreamAlreadyFinishingError.isInstance(ex);
          });
        },

        "should support fail": () => {
          const { fail, state } = createDummySinkStreamInFinishingState();

          const testError = Error("test error");

          fail({ error: testError });

          assert.deepStrictEqual(state(), {
            calls: {
              drain: [],
              fail: [
                { error: testError }
              ]
            }
          });
        },

        "should support destroy": () => {
          const { sinkStream } = createDummySinkStreamInFinishingState();
          sinkStream.destroy();
        },
      }
    },

    "finished state": {
      tests: {
        "should throw when write is called": () => {
          const { sinkStream } = createDummySinkStreamInFinishedState();

          assert.throws(() => {
            sinkStream.write({ chunks: ["abc"] });
          }, (ex: Error) => {
            return StreamAlreadyFinishedError.isInstance(ex);
          });
        },

        "should throw when finish is called": () => {
          const { sinkStream } = createDummySinkStreamInFinishedState();

          assert.throws(() => {
            sinkStream.finish({ done: () => { } });
          }, (ex: Error) => {
            return StreamAlreadyFinishedError.isInstance(ex);
          });
        },

        "should throw when fail is called": () => {
          const { fail } = createDummySinkStreamInFinishedState();

          const testError = Error("test error");

          assert.throws(() => {
            fail({ error: testError });
          }, (ex: Error) => {
            return StreamAlreadyFinishedError.isInstance(ex);
          });
        },

        "should throw when destroy is called": () => {
          const { sinkStream } = createDummySinkStreamInFinishedState();

          assert.throws(() => {
            sinkStream.destroy();
          }, (ex: Error) => {
            return StreamAlreadyFinishedError.isInstance(ex);
          });
        },
      }
    },

    "failed state": {
      tests: {
        "should throw when write is called": () => {
          const { sinkStream } = createDummySinkStreamInFailedState();

          assert.throws(() => {
            sinkStream.write({ chunks: ["abc"] });
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },

        "should throw when finish is called": () => {
          const { sinkStream } = createDummySinkStreamInFailedState();

          assert.throws(() => {
            sinkStream.finish({ done: () => { } });
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },

        "should throw when fail is called": () => {
          const { fail } = createDummySinkStreamInFailedState();

          const testError = Error("test error");

          assert.throws(() => {
            fail({ error: testError });
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },

        "should throw when destroy is called": () => {
          const { sinkStream } = createDummySinkStreamInFailedState();

          assert.throws(() => {
            sinkStream.destroy();
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },
      }
    },

    "destroyed state": {
      tests: {
        "should throw when write is called": () => {
          const { sinkStream } = createDummySinkStreamInDestroyedState();

          assert.throws(() => {
            sinkStream.write({ chunks: ["abc"] });
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },

        "should throw when finish is called": () => {
          const { sinkStream } = createDummySinkStreamInDestroyedState();

          assert.throws(() => {
            sinkStream.finish({ done: () => { } });
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },

        "should throw when fail is called": () => {
          const { fail } = createDummySinkStreamInDestroyedState();

          assert.throws(() => {
            fail({ error: Error("test error") });
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },

        "should throw on calls to destroy": () => {
          const { sinkStream } = createDummySinkStreamInDestroyedState();
          assert.throws(() => {
            sinkStream.destroy();
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },
      }
    },

    // "should throw when empty chunks are written": () => {
    //     const { next } = createDummySourceStreamInStreamingState();

    //     assert.throws(() => {
    //         next({ chunks: [] });
    //     }, (ex: any) => {
    //         return ex.message === "cannot write an empty chunk array";
    //     });
    // },

    // "should throw when fail is called without error": () => {
    //     const { fail } = createDummySourceStreamInStreamingState();

    //     assert.throws(() => {
    //         // @ts-ignore
    //         fail({});
    //     }, (ex: any) => {
    //         return ex.message === "cannot fail a stream with an undefined error";
    //     });
    // },

    // "should throw when opened more than once": () => {
    //     const sourceFactory = source({
    //         open: () => {
    //             return {
    //                 pause: () => { },
    //                 resume: () => { },
    //                 destroy: () => { }
    //             };
    //         }
    //     });

    //     sourceFactory.open({
    //         next: () => { },
    //         end: () => { },
    //         fail: () => { }
    //     });

    //     assert.throws(() => {
    //         sourceFactory.open({
    //             next: () => { },
    //             end: () => { },
    //             fail: () => { }
    //         });
    //     }, (ex: any) => {
    //         return ex.message === "cannot open a stream that is already open";
    //     });
    // },

    "reentrancy": sinkReentrancyTestGroup
  }
};

export {
  sinkTestGroup
};
