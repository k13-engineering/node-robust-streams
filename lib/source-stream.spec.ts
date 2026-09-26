import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { sourceGuard } from "./source-stream.ts";
import type { TSourceStream, TSourceStreamStatus } from "./source-stream.ts";
import {
  createControllableSource,
  moduleUrl,
  nextTask,
  pollHandle,
  runModule,
  textChunks
} from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

const OPEN: TSourceStreamStatus = Object.freeze({ type: "open" });
const ENDED: TSourceStreamStatus = Object.freeze({ type: "ended" });

// an always open source doing nothing, individual members can be replaced
const createStubSource = ({ overrides }: { overrides: Partial<TSourceStream<TTextChunk>> }): TSourceStream<TTextChunk> => {
  return {
    status: () => {
      return OPEN;
    },
    read: () => {
      return { chunks: [] };
    },
    poll: () => {
      return pollHandle({ type: "pending" });
    },
    destroy: () => {
      // nothing to destroy
    },
    ...overrides
  };
};

const guardedIn = ({ type }: { type: TSourceStreamStatus["type"] }) => {
  return sourceGuard({ source: createControllableSource<TTextChunk>({ initial: type }).source });
};

describe("sourceGuard", () => {

  describe("status", () => {
    it("should pass the status through, deeply frozen", () => {
      const status = guardedIn({ type: "open" }).status();

      assert.deepEqual(status, { type: "open" });
      assert.ok(Object.isFrozen(status));
    });

    it("should throw if status() does not yield the same result when called repeatedly", () => {
      let flip = false;
      const guarded = sourceGuard({
        source: createStubSource({
          overrides: {
            status: () => {
              flip = !flip;
              return flip ? OPEN : ENDED;
            }
          }
        })
      });

      assert.throws(() => {
        guarded.status();
      }, /contract violation: source\.status\(\) MUST yield the same result when called repeatedly/);
    });

    it("should throw on an unknown status", () => {
      const guarded = sourceGuard({
        source: createStubSource({
          overrides: {
            status: () => {
              return { type: "unknown" } as unknown as TSourceStreamStatus;
            }
          }
        })
      });

      assert.throws(() => {
        guarded.status();
      }, /contract violation: source\.status\(\) MUST NOT yield the unknown status unknown/);
    });

    it("should throw on a status transition that is not allowed", () => {
      const { source, set } = createControllableSource<TTextChunk>({ initial: "ended" });
      const guarded = sourceGuard({ source });

      guarded.status();
      set({ type: "open" });

      assert.throws(() => {
        guarded.status();
      }, /contract violation: source: status ended MUST NOT change to open/);
    });

    it("should accept several transitions between two observations", () => {
      const { source, set } = createControllableSource<TTextChunk>({ initial: "opening" });
      const guarded = sourceGuard({ source });

      guarded.status();
      set({ type: "ended" });

      assert.deepEqual(guarded.status(), { type: "ended" });
    });
  });

  describe("calls in forbidden statuses", () => {
    it("should throw when read() is called in a forbidden status", () => {
      const forbidden = ["opening", "ending", "ended", "failing", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).read();
        }, new RegExp(`contract violation: source\\.read\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when poll() is called in a forbidden status", () => {
      const forbidden = ["ended", "failed", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).poll({ onUpdate: () => {} });
        }, new RegExp(`contract violation: source\\.poll\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when destroy() is called in a forbidden status", () => {
      const forbidden = ["ended", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).destroy();
        }, new RegExp(`contract violation: source\\.destroy\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should pass calls in allowed statuses through", () => {
      const { source, provide } = createControllableSource<TTextChunk>({ initial: "open" });
      const guarded = sourceGuard({ source });

      provide({ chunks: textChunks({ texts: ["a", "b"] }) });
      assert.deepEqual(guarded.read(), { chunks: textChunks({ texts: ["a", "b"] }) });

      guarded.destroy();
      assert.deepEqual(guarded.status(), { type: "destroying" });
    });
  });

  describe("read", () => {
    it("should deeply freeze the read result, except array buffer views", () => {
      const data = new Uint8Array(4);
      const guarded = sourceGuard({
        source: createStubSource({
          overrides: {
            read: () => {
              return { chunks: [{ text: "a", data, meta: { nested: true } }] };
            }
          }
        })
      });

      const [chunk] = guarded.read().chunks as unknown as readonly { meta: object; data: Uint8Array }[];
      assert.ok(Object.isFrozen(chunk));
      assert.ok(Object.isFrozen(chunk.meta));
      assert.equal(chunk.data, data);
      assert.ok(!Object.isFrozen(chunk.data));
    });
  });
});

describe("sourceGuard poll", () => {

  it("should pass a correct poll through", async () => {
    const { source, provide } = createControllableSource<TTextChunk>({ initial: "open" });
    const guarded = sourceGuard({ source });
    let calls = 0;

    const handle = guarded.poll({
      onUpdate: () => {
        calls += 1;
      }
    });
    provide({ chunks: textChunks({ texts: ["a"] }) });

    await nextTask();
    assert.equal(calls, 1);
    assert.deepEqual(handle.status(), { type: "triggered" });
  });

  it("should throw if onUpdate is called synchronously within poll()", () => {
    const guarded = sourceGuard({
      source: createStubSource({
        overrides: {
          poll: ({ onUpdate }) => {
            onUpdate();
            return pollHandle({ type: "pending" });
          }
        }
      })
    });

    assert.throws(() => {
      guarded.poll({ onUpdate: () => {} });
    }, /contract violation: source: onUpdate MUST NOT be called synchronously/);
  });

  it("should throw if onUpdate is called synchronously within another method", () => {
    let stored = () => {};
    const guarded = sourceGuard({
      source: createStubSource({
        overrides: {
          poll: ({ onUpdate }) => {
            stored = onUpdate;
            return pollHandle({ type: "pending" });
          },
          read: () => {
            stored();
            return { chunks: [] };
          }
        }
      })
    });

    guarded.poll({ onUpdate: () => {} });
    assert.throws(() => {
      guarded.read();
    }, /contract violation: source: onUpdate MUST NOT be called synchronously/);
  });

  it("should throw if the poll handle does not yield triggered when onUpdate is called", () => {
    let stored = () => {};
    const guarded = sourceGuard({
      source: createStubSource({
        overrides: {
          poll: ({ onUpdate }) => {
            stored = onUpdate;
            return pollHandle({ type: "pending" });
          }
        }
      })
    });

    guarded.poll({ onUpdate: () => {} });
    assert.throws(() => {
      stored();
    }, /contract violation: source: the poll handle MUST already yield triggered when onUpdate is called/);
  });

  it("should throw if poll() changes the status synchronously", () => {
    let status: TSourceStreamStatus = OPEN;
    const guarded = sourceGuard({
      source: createStubSource({
        overrides: {
          status: () => {
            return status;
          },
          poll: () => {
            status = { type: "failing" };
            return pollHandle({ type: "pending" });
          }
        }
      })
    });

    assert.throws(() => {
      guarded.poll({ onUpdate: () => {} });
    }, /contract violation: source\.poll\(\) MUST NOT change the status synchronously/);
  });

  it("should throw if poll() returns a handle that is not pending", () => {
    const guarded = sourceGuard({
      source: createStubSource({
        overrides: {
          poll: () => {
            return pollHandle({ type: "triggered" });
          }
        }
      })
    });

    assert.throws(() => {
      guarded.poll({ onUpdate: () => {} });
    }, /contract violation: source\.poll\(\) MUST return a pending poll handle/);
  });

  it("should throw if the status of the poll handle is not stable", () => {
    let flip = false;
    const guarded = sourceGuard({
      source: createStubSource({
        overrides: {
          poll: () => {
            return {
              status: () => {
                flip = !flip;
                return { type: flip ? "pending" : "cancelled" };
              },
              cancel: () => {}
            };
          }
        }
      })
    });

    assert.throws(() => {
      guarded.poll({ onUpdate: () => {} });
    }, /contract violation: source poll handle\.status\(\) MUST yield the same result when called repeatedly/);
  });

  it("should pass cancel() through, but throw if the handle is not pending anymore", () => {
    const guarded = guardedIn({ type: "open" });
    const handle = guarded.poll({ onUpdate: () => {} });

    handle.cancel();
    assert.deepEqual(handle.status(), { type: "cancelled" });

    assert.throws(() => {
      handle.cancel();
    }, /contract violation: source poll handle\.cancel\(\) MUST NOT be called in status cancelled/);
  });

  it("should not catch exceptions thrown from onUpdate, they crash the process", () => {
    const result = runModule({
      source: [
        `import { fixedChunksSource } from ${JSON.stringify(moduleUrl({ file: "./fixed-chunks-source.ts" }))};`,
        `import { sourceGuard } from ${JSON.stringify(moduleUrl({ file: "./source-stream.ts" }))};`,
        `const source = sourceGuard({ source: fixedChunksSource({ chunks: [{ text: "a" }] }) });`,
        `source.poll({ onUpdate: () => { throw Error("thrown from onUpdate"); } });`
      ].join("\n")
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /thrown from onUpdate/);
  });
});
