import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { syncDuplex } from "./sync-duplex.ts";
import { duplexGuard } from "./duplex-stream.ts";
import type { TDuplexStream, TDuplexStreamStatus } from "./duplex-stream.ts";
import { pollHandle, textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

// a duplex whose status is set by the test, its transactions stay pending
const createScriptedDuplex = ({ initial }: { initial: TDuplexStreamStatus["type"] }) => {
  let status: TDuplexStreamStatus = { type: initial };

  const duplex: TDuplexStream<TTextChunk, TTextChunk> = {
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
    duplex,
    setStatus: ({ type }: { type: TDuplexStreamStatus["type"] }) => {
      status = { type };
    }
  };
};

const guardedIn = ({ type }: { type: TDuplexStreamStatus["type"] }) => {
  return duplexGuard({ duplex: createScriptedDuplex({ initial: type }).duplex });
};

const WRITE_INACTIVE = ["opening", "flushing", "done", "failing", "failed", "destroying", "destroyed"] as const;

describe("duplexGuard", () => {

  describe("calls in forbidden statuses", () => {
    it("should throw when read() is called in a forbidden status", () => {
      const forbidden = ["opening", "done", "failing", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).read();
        }, new RegExp(`contract violation: duplex\\.read\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should allow read() while flushing", () => {
      assert.deepEqual(guardedIn({ type: "flushing" }).read(), { chunks: [] });
    });

    it("should throw when write() is called in a forbidden status", () => {
      WRITE_INACTIVE.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).write({ chunks: textChunks({ texts: ["a"] }) });
        }, new RegExp(`contract violation: duplex\\.write\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when end() is called in a forbidden status", () => {
      WRITE_INACTIVE.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).end();
        }, new RegExp(`contract violation: duplex\\.end\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when poll() is called in a forbidden status", () => {
      const forbidden = ["done", "failed", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).poll({ onUpdate: () => {} });
        }, new RegExp(`contract violation: duplex\\.poll\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when destroy() is called in a forbidden status", () => {
      const forbidden = ["done", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).destroy();
        }, new RegExp(`contract violation: duplex\\.destroy\\(\\) MUST NOT be called in status ${type}`));
      });
    });
  });

  describe("transactions", () => {
    it("should throw when write() is called with an empty chunks array", () => {
      assert.throws(() => {
        guardedIn({ type: "open" }).write({ chunks: [] });
      }, /contract violation: duplex\.write\(\) MUST NOT be called with an empty chunks array/);
    });

    it("should throw if a transaction is still pending once done", () => {
      const { duplex, setStatus } = createScriptedDuplex({ initial: "open" });
      const guarded = duplexGuard({ duplex });

      guarded.write({ chunks: textChunks({ texts: ["a"] }) });
      setStatus({ type: "done" });

      assert.throws(() => {
        guarded.status();
      }, /contract violation: duplex: transactions MUST NOT be pending in status done/);
    });

    it("should pass a valid lifecycle through", () => {
      const guarded = duplexGuard({
        duplex: syncDuplex<TTextChunk, TTextChunk>({
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
