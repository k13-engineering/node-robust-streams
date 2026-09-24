import assert from "node:assert";

import type { ITestGroup } from "ya-test-library";

import { sink } from "../../lib/sink.ts";
import {
  StreamAlreadyDestroyedError,
  StreamAlreadyFailedError,
  StreamAlreadyFinishedError,
  StreamAlreadyFinishingError
} from "../../lib/errors.ts";
import { sinkReentrancyTestGroup } from "./reentrancy.ts";

const createDummySinkStream = () => {
  let capturedBackpressure: ((args: { pressure: number }) => void) | undefined = undefined;
  let capturedFail: ((args: { error: Error }) => void) | undefined = undefined;
  let capturedDone: (() => void) | undefined = undefined;

  const sinkFactory = sink({
    openSinkStream: ({ backpressure, fail }) => {
      capturedBackpressure = backpressure;
      capturedFail = fail;

      return {
        write: () => {
          return undefined;
        },
        finish: ({ done }) => {
          capturedDone = done;
          return undefined;
        },
        destroy: () => { },
      };
    }
  });

  let state = {
    calls: {
      backpressure: [] as { pressure: number }[],
      fail: [] as { error: Error }[],
    }
  };

  const sinkStream = sinkFactory.openSinkStream({
    backpressure: ({ pressure }) => {
      state = {
        ...state,
        calls: {
          ...state.calls,
          backpressure: [
            ...state.calls.backpressure,
            { pressure }
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

  assert.ok(capturedBackpressure !== undefined);
  assert.ok(capturedFail !== undefined);

  return {
    sinkStream,

    backpressure: capturedBackpressure! as (args: { pressure: number }) => void,
    fail: capturedFail! as (args: { error: Error }) => void,

    done,

    state: () => {
      return state;
    }
  };
};

const createDummySinkStreamInStreamingState = () => {

  const {
    sinkStream,
    backpressure,
    fail,
    state
  } = createDummySinkStream();

  return {
    sinkStream,

    backpressure,
    fail,

    state,
  };
};

const createDummySinkStreamInDestroyedState = () => {

  const {
    sinkStream,
    backpressure,
    fail,
    state
  } = createDummySinkStream();

  sinkStream.destroy({ reason: "test" });

  return {
    sinkStream,

    backpressure,
    fail,

    state,
  };
};

const createDummySinkStreamInFinishingState = () => {
  const {
    sinkStream,
    backpressure,
    fail,
    state
  } = createDummySinkStream();

  sinkStream.finish({ done: () => { } });

  return {
    sinkStream,

    backpressure,
    fail,

    state
  };
};

const createDummySinkStreamInFinishedState = () => {
  const {
    sinkStream,
    backpressure,
    fail,

    done,

    state
  } = createDummySinkStream();

  sinkStream.finish({ done: () => { } });
  done();

  return {
    sinkStream,

    backpressure,
    fail,

    state,
  };
};

const createDummySinkStreamInFailedState = () => {
  const {
    sinkStream,
    backpressure,
    fail,
    state
  } = createDummySinkStream();

  fail({ error: Error("test error") });

  return {
    sinkStream,

    backpressure,
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

// [inside] backpressure
// [inside] fail

// [outside] write
// [outside] finish
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

        "should support backpressure": () => {
          const { backpressure, state } = createDummySinkStreamInStreamingState();

          backpressure({ pressure: 0.5 });

          assert.deepStrictEqual(state(), {
            calls: {
              backpressure: [
                { pressure: 0.5 }
              ],
              fail: []
            }
          });
        },

        "should support fail": () => {
          const { fail, state } = createDummySinkStreamInStreamingState();

          const testError = Error("test error");

          fail({ error: testError });

          assert.deepStrictEqual(state(), {
            calls: {
              backpressure: [],
              fail: [
                { error: testError }
              ]
            }
          });
        },

        "should support destroy": () => {
          const { sinkStream } = createDummySinkStreamInStreamingState();
          sinkStream.destroy({ reason: "test" });
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

        "should throw when backpressure is called": () => {
          const { backpressure } = createDummySinkStreamInFinishingState();

          assert.throws(() => {
            backpressure({ pressure: 0 });
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
              backpressure: [],
              fail: [
                { error: testError }
              ]
            }
          });
        },

        "should support destroy": () => {
          const { sinkStream } = createDummySinkStreamInFinishingState();
          sinkStream.destroy({ reason: "test" });
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

        "should throw when backpressure is called": () => {
          const { backpressure } = createDummySinkStreamInFinishedState();

          assert.throws(() => {
            backpressure({ pressure: 0 });
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
            sinkStream.destroy({ reason: "test" });
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

        "should throw when backpressure is called": () => {
          const { backpressure } = createDummySinkStreamInFailedState();

          assert.throws(() => {
            backpressure({ pressure: 0 });
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
            sinkStream.destroy({ reason: "test" });
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

        "should throw when backpressure is called": () => {
          const { backpressure } = createDummySinkStreamInDestroyedState();

          assert.throws(() => {
            backpressure({ pressure: 0 });
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
            sinkStream.destroy({ reason: "test" });
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

    "reentrancy": sinkReentrancyTestGroup
  },

  tests: {
    "should throw when backpressure is out of range": () => {
      const { backpressure } = createDummySinkStreamInStreamingState();

      assert.throws(() => {
        backpressure({ pressure: 1.5 });
      }, (ex: Error) => {
        return ex.message === "backpressure: pressure must be between 0 and 1";
      });
    },

    "should throw when opened more than once": () => {
      const sinkFactory = sink({
        openSinkStream: () => {
          return {
            write: () => {
              return undefined;
            },
            finish: () => {
              return undefined;
            },
            destroy: () => { }
          };
        }
      });

      sinkFactory.openSinkStream({
        backpressure: () => { },
        fail: () => { }
      });

      assert.throws(() => {
        sinkFactory.openSinkStream({
          backpressure: () => { },
          fail: () => { }
        });
      }, (ex: Error) => {
        return ex.message === "cannot open a stream that is already open";
      });
    },
  }
};

export {
  sinkTestGroup
};
