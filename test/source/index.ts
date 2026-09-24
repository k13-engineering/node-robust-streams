import assert from "node:assert";

import type { ITestGroup } from "ya-test-library";

import { source } from "../../lib/source.ts";
import {
  StreamAlreadyDestroyedError,
  StreamAlreadyEndedError,
  StreamAlreadyFailedError,
  StreamAlreadyOpenedError
} from "../../lib/errors.ts";

import { sourceReentrancyTestGroup } from "./reentrancy.ts";
import type { TStreamChunk } from "../../lib/stream.ts";

const createDummySourceStream = () => {
  let capturedNext: ((args: { chunks: TStreamChunk[] }) => void) | undefined = undefined;
  let capturedEnd: (() => void) | undefined = undefined;
  let capturedFail: ((args: { error: Error }) => void) | undefined = undefined;

  const sourceFactory = source({
    openSourceStream: ({ next, end, fail }) => {
      capturedNext = next;
      capturedEnd = end;
      capturedFail = fail;

      return {
        backpressure: () => { },
        destroy: () => { }
      };
    }
  });

  let state = {
    calls: {
      next: [] as { chunks: TStreamChunk[] }[],
      end: [] as undefined[],
      fail: [] as { error: Error }[],
    }
  };

  const sourceStream = sourceFactory.openSourceStream({
    next: ({ chunks }) => {
      state = {
        ...state,
        calls: {
          ...state.calls,
          next: [
            ...state.calls.next,
            { chunks }
          ]
        }
      };
    },
    end: () => {
      state = {
        ...state,
        calls: {
          ...state.calls,
          end: [
            ...state.calls.end,
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

  assert.ok(capturedNext !== undefined);
  assert.ok(capturedEnd !== undefined);
  assert.ok(capturedFail !== undefined);

  return {
    sourceStream,

    next: capturedNext! as (args: { chunks: TStreamChunk[] }) => void,
    end: capturedEnd! as () => void,
    fail: capturedFail! as (args: { error: Error }) => void,

    state: () => {
      return state;
    }
  };
};

const createDummySourceStreamInOpenState = () => {
  return createDummySourceStream();
};

const createDummySourceStreamInDestroyedState = () => {

  const {
    sourceStream,
    next,
    end,
    fail,
    state
  } = createDummySourceStream();

  sourceStream.destroy();

  return {
    sourceStream,

    next,
    end,
    fail,

    state,
  };
};

const createDummySourceStreamInEndedState = () => {
  const {
    sourceStream,
    next,
    end,
    fail,
    state
  } = createDummySourceStream();

  end();

  return {
    sourceStream,

    next,
    end,
    fail,

    state: () => {
      const s = state();

      return {
        ...s,
        calls: {
          ...s.calls,
          end: s.calls.end.slice(1)
        }
      };
    },
  };
};

const createDummySourceStreamInFailedState = () => {
  const {
    sourceStream,
    next,
    end,
    fail,
    state
  } = createDummySourceStream();

  fail({ error: Error("test error") });

  return {
    sourceStream,

    next,
    end,
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

// [outside] backpressure
// [outside] destroy

const sourceTestGroup: ITestGroup = {
  groups: {

    "open state": {
      tests: {
        "should support next": () => {
          const { next, state } = createDummySourceStreamInOpenState();

          const testChunks = ["abc", "def", "ghi"];

          next({ chunks: testChunks });

          assert.deepStrictEqual(state(), {
            calls: {
              next: [
                { chunks: testChunks }
              ],
              end: [],
              fail: []
            }
          });
        },

        "should support end": () => {
          const { end, state } = createDummySourceStreamInOpenState();

          end();

          assert.deepStrictEqual(state(), {
            calls: {
              next: [],
              end: [
                undefined
              ],
              fail: []
            }
          });
        },

        "should support fail": () => {
          const { fail, state } = createDummySourceStreamInOpenState();

          const testError = Error("test error");

          fail({ error: testError });

          assert.deepStrictEqual(state(), {
            calls: {
              next: [],
              end: [],
              fail: [
                { error: testError }
              ]
            }
          });
        },

        "should support backpressure": () => {
          const { sourceStream } = createDummySourceStreamInOpenState();
          sourceStream.backpressure({ pressure: 0 });
          sourceStream.backpressure({ pressure: 1 });
        },

        "should support destroy": () => {
          const { sourceStream } = createDummySourceStreamInOpenState();
          sourceStream.destroy();
        },
      }
    },

    "ended state": {
      tests: {
        "should throw when next is called": () => {
          const { next } = createDummySourceStreamInEndedState();

          assert.throws(() => {
            next({ chunks: ["abc"] });
          }, (ex: Error) => {
            return StreamAlreadyEndedError.isInstance(ex);
          });
        },

        "should throw when end is called": () => {
          const { end } = createDummySourceStreamInEndedState();

          assert.throws(() => {
            end();
          }, (ex: Error) => {
            return StreamAlreadyEndedError.isInstance(ex);
          });
        },

        "should throw when fail is called": () => {
          const { fail } = createDummySourceStreamInEndedState();

          assert.throws(() => {
            fail({ error: Error("test error") });
          }, (ex: Error) => {
            return StreamAlreadyEndedError.isInstance(ex);
          });
        },

        "should throw on calls to backpressure": () => {
          const { sourceStream } = createDummySourceStreamInEndedState();
          assert.throws(() => {
            sourceStream.backpressure({ pressure: 0 });
          }, (ex: Error) => {
            return StreamAlreadyEndedError.isInstance(ex);
          });
        },

        "should throw on calls to destroy": () => {
          const { sourceStream } = createDummySourceStreamInEndedState();
          assert.throws(() => {
            sourceStream.destroy();
          }, (ex: Error) => {
            return StreamAlreadyEndedError.isInstance(ex);
          });
        },
      }
    },

    "failed state": {
      tests: {
        "should throw when next is called": () => {
          const { next } = createDummySourceStreamInFailedState();

          assert.throws(() => {
            next({ chunks: ["abc"] });
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },

        "should throw when end is called": () => {
          const { end } = createDummySourceStreamInFailedState();

          assert.throws(() => {
            end();
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },

        "should throw when fail is called": () => {
          const { fail } = createDummySourceStreamInFailedState();

          assert.throws(() => {
            fail({ error: Error("test error") });
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },

        "should throw on calls to backpressure": () => {
          const { sourceStream } = createDummySourceStreamInFailedState();
          assert.throws(() => {
            sourceStream.backpressure({ pressure: 0 });
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },

        "should throw on calls to destroy": () => {
          const { sourceStream } = createDummySourceStreamInFailedState();
          assert.throws(() => {
            sourceStream.destroy();
          }, (ex: Error) => {
            return StreamAlreadyFailedError.isInstance(ex);
          });
        },
      }
    },

    "destroyed state": {
      tests: {
        "should throw when next is called": () => {
          const { next } = createDummySourceStreamInDestroyedState();

          assert.throws(() => {
            next({ chunks: ["abc"] });
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },

        "should throw when end is called": () => {
          const { end } = createDummySourceStreamInDestroyedState();

          assert.throws(() => {
            end();
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },

        "should throw when fail is called": () => {
          const { fail } = createDummySourceStreamInDestroyedState();

          assert.throws(() => {
            fail({ error: Error("test error") });
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },

        "should throw on calls to backpressure": () => {
          const { sourceStream } = createDummySourceStreamInDestroyedState();
          assert.throws(() => {
            sourceStream.backpressure({ pressure: 0 });
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },

        "should throw on calls to destroy": () => {
          const { sourceStream } = createDummySourceStreamInDestroyedState();
          assert.throws(() => {
            sourceStream.destroy();
          }, (ex: Error) => {
            return StreamAlreadyDestroyedError.isInstance(ex);
          });
        },
      },
    },

    "reentrancy": sourceReentrancyTestGroup,


  },

  tests: {
    "should throw when empty chunks are written": () => {
      const { next } = createDummySourceStreamInOpenState();

      assert.throws(() => {
        next({ chunks: [] });
      }, (ex: Error) => {
        return ex.message === "cannot write an empty chunk array";
      });
    },

    "should throw when fail is called without error": () => {
      const { fail } = createDummySourceStreamInOpenState();

      assert.throws(() => {
        // @ts-expect-error test case
        fail({});
      }, (ex: Error) => {
        return ex.message === "cannot fail a stream with an undefined error";
      });
    },

    "should throw when next is called before open returns": () => {
      const sourceFactory = source({
        openSourceStream: ({ next }) => {
          next({ chunks: ["abc"] });

          return {
            backpressure: () => { },
            destroy: () => { }
          };
        }
      });

      assert.throws(() => {
        sourceFactory.openSourceStream({
          next: () => { },
          end: () => { },
          fail: () => { }
        });
      }, (ex: Error) => {
        return ex.message === "cannot call next before open returns";
      });
    },

    "should throw when end is called before open returns": () => {
      const sourceFactory = source({
        openSourceStream: ({ end }) => {
          end();

          return {
            backpressure: () => { },
            destroy: () => { }
          };
        }
      });

      assert.throws(() => {
        sourceFactory.openSourceStream({
          next: () => { },
          end: () => { },
          fail: () => { }
        });
      }, (ex: Error) => {
        return ex.message === "cannot call end before open returns";
      });
    },

    "should throw when opened more than once": () => {
      const sourceFactory = source({
        openSourceStream: () => {
          return {
            backpressure: () => { },
            destroy: () => { }
          };
        }
      });

      sourceFactory.openSourceStream({
        next: () => { },
        end: () => { },
        fail: () => { }
      });

      assert.throws(() => {
        sourceFactory.openSourceStream({
          next: () => { },
          end: () => { },
          fail: () => { }
        });
      }, (ex: Error) => {
        return StreamAlreadyOpenedError.isInstance(ex) && ex.message === "cannot open a stream that is already open";
      });
    },
  },
};

export {
  sourceTestGroup
};
