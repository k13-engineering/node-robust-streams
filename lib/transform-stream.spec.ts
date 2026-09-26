import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { syncTransform } from "./sync-transform.ts";
import { transformGuard } from "./transform-stream.ts";
import type { TTransformStream, TTransformStreamStatus } from "./transform-stream.ts";
import { pollHandle, textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

// a transform whose status is set by the test, its transactions stay pending
const createScriptedTransform = ({ initial }: { initial: TTransformStreamStatus["type"] }) => {
  let status: TTransformStreamStatus = { type: initial };

  const transform: TTransformStream<TTextChunk, TTextChunk> = {
    status: () => {
      return status;
    },
    read: () => {
      return { chunks: [] };
    },
    write: () => {
      return {
        status: () => {
          return { type: "pending" };
        }
      };
    },
    end: () => {
      status = { type: "flushing" };
    },
    poll: () => {
      return pollHandle({ type: "pending" });
    },
    destroy: () => {
      status = { type: "destroying" };
    }
  };

  return {
    transform,
    setStatus: ({ type }: { type: TTransformStreamStatus["type"] }) => {
      status = { type };
    }
  };
};

const guardedIn = ({ type }: { type: TTransformStreamStatus["type"] }) => {
  return transformGuard({ transform: createScriptedTransform({ initial: type }).transform });
};

const WRITE_INACTIVE = ["opening", "flushing", "done", "failing", "failed", "destroying", "destroyed"] as const;

describe("transformGuard", () => {

  describe("calls in forbidden statuses", () => {
    it("should throw when read() is called in a forbidden status", () => {
      const forbidden = ["opening", "done", "failing", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).read();
        }, new RegExp(`contract violation: transform\\.read\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should allow read() while flushing", () => {
      assert.deepEqual(guardedIn({ type: "flushing" }).read(), { chunks: [] });
    });

    it("should throw when write() is called in a forbidden status", () => {
      WRITE_INACTIVE.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).write({ chunks: textChunks({ texts: ["a"] }) });
        }, new RegExp(`contract violation: transform\\.write\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when end() is called in a forbidden status", () => {
      WRITE_INACTIVE.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).end();
        }, new RegExp(`contract violation: transform\\.end\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when poll() is called in a forbidden status", () => {
      const forbidden = ["done", "failed", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).poll({ onUpdate: () => {} });
        }, new RegExp(`contract violation: transform\\.poll\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when destroy() is called in a forbidden status", () => {
      const forbidden = ["done", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).destroy();
        }, new RegExp(`contract violation: transform\\.destroy\\(\\) MUST NOT be called in status ${type}`));
      });
    });
  });

  describe("transactions", () => {
    it("should throw when write() is called with an empty chunks array", () => {
      assert.throws(() => {
        guardedIn({ type: "open" }).write({ chunks: [] });
      }, /contract violation: transform\.write\(\) MUST NOT be called with an empty chunks array/);
    });

    it("should throw if a transaction is still pending once done", () => {
      const { transform, setStatus } = createScriptedTransform({ initial: "open" });
      const guarded = transformGuard({ transform });

      guarded.write({ chunks: textChunks({ texts: ["a"] }) });
      setStatus({ type: "done" });

      assert.throws(() => {
        guarded.status();
      }, /contract violation: transform: transactions MUST NOT be pending in status done/);
    });

    it("should pass a valid lifecycle through", () => {
      const guarded = transformGuard({
        transform: syncTransform<TTextChunk, TTextChunk>({
          transform: ({ chunks }) => {
            return { chunks };
          }
        })
      });

      const transaction = guarded.write({ chunks: textChunks({ texts: ["a"] }) });
      guarded.end();
      assert.deepEqual(guarded.read(), { chunks: textChunks({ texts: ["a"] }) });

      assert.deepEqual(transaction.status(), { type: "committed" });
      assert.deepEqual(guarded.status(), { type: "done" });
    });
  });
});
