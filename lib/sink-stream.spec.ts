import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { sinkGuard } from "./sink-stream.ts";
import type {
  TSinkStream,
  TSinkStreamStatus,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";
import { createControllableSink, pollHandle, textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

type TTransactionType = TSinkStreamWriteTransactionStatus["type"];

// a sink whose status and transaction statuses are set directly by the test, even to invalid combinations
const createScriptedSink = () => {
  let status: TSinkStreamStatus = { type: "open" };
  let transactions: readonly TTransactionType[] = [];
  let written: readonly (readonly TTextChunk[])[] = [];

  const sink: TSinkStream<TTextChunk> = {
    status: () => {
      return status;
    },
    write: ({ chunks }) => {
      const index = transactions.length;
      transactions = [...transactions, "pending"];
      written = [...written, chunks];
      return {
        status: () => {
          return { type: transactions[index] };
        }
      };
    },
    end: () => {
      status = { type: "finishing" };
    },
    poll: () => {
      return pollHandle({ type: "pending" });
    },
    destroy: () => {
      status = { type: "destroying" };
    }
  };

  return {
    sink,
    setStatus: ({ type }: { type: TSinkStreamStatus["type"] }) => {
      status = { type };
    },
    setTransaction: ({ index, type }: { index: number; type: TTransactionType }) => {
      transactions = transactions.map((current, position) => {
        return position === index ? type : current;
      });
    },
    written: () => {
      return written;
    }
  };
};

const guardedIn = ({ type }: { type: TSinkStreamStatus["type"] }) => {
  return sinkGuard({ sink: createControllableSink<TTextChunk>({ initial: type }).sink });
};

const INACTIVE = ["opening", "finishing", "finished", "failing", "failed", "destroying", "destroyed"] as const;

describe("sinkGuard", () => {

  describe("calls in forbidden statuses", () => {
    it("should throw when write() is called in a forbidden status", () => {
      INACTIVE.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).write({ chunks: textChunks({ texts: ["a"] }) });
        }, new RegExp(`contract violation: sink\\.write\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when end() is called in a forbidden status", () => {
      INACTIVE.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).end();
        }, new RegExp(`contract violation: sink\\.end\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when poll() is called in a forbidden status", () => {
      const forbidden = ["finished", "failed", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).poll({ onUpdate: () => {} });
        }, new RegExp(`contract violation: sink\\.poll\\(\\) MUST NOT be called in status ${type}`));
      });
    });

    it("should throw when destroy() is called in a forbidden status", () => {
      const forbidden = ["finished", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        assert.throws(() => {
          guardedIn({ type }).destroy();
        }, new RegExp(`contract violation: sink\\.destroy\\(\\) MUST NOT be called in status ${type}`));
      });
    });
  });

  describe("write", () => {
    it("should throw when write() is called with an empty chunks array", () => {
      assert.throws(() => {
        guardedIn({ type: "open" }).write({ chunks: [] });
      }, /contract violation: sink\.write\(\) MUST NOT be called with an empty chunks array/);
    });

    it("should hand the chunks over deeply frozen", () => {
      const { sink, written } = createScriptedSink();
      const chunks = [{ text: "a" }];

      sinkGuard({ sink }).write({ chunks });

      assert.equal(written()[0], chunks);
      assert.ok(Object.isFrozen(chunks));
      assert.ok(Object.isFrozen(chunks[0]));
    });

    it("should pass a valid lifecycle through", () => {
      const { sink, set, commit } = createControllableSink<TTextChunk>({ initial: "open" });
      const guarded = sinkGuard({ sink });

      const transaction = guarded.write({ chunks: textChunks({ texts: ["a"] }) });
      assert.deepEqual(transaction.status(), { type: "pending" });

      commit({ count: 1 });
      guarded.end();
      set({ type: "finished" });

      assert.deepEqual(transaction.status(), { type: "committed" });
      assert.deepEqual(guarded.status(), { type: "finished" });
    });

    it("should accept a transaction that is committed right away", () => {
      const { sink, setTransaction } = createScriptedSink();

      const wrapped = {
        ...sink,
        write: (args: Parameters<typeof sink.write>[0]) => {
          const transaction = sink.write(args);
          setTransaction({ index: 0, type: "committed" });
          return transaction;
        }
      };

      const transaction = sinkGuard({ sink: wrapped }).write({ chunks: textChunks({ texts: ["a"] }) });
      assert.deepEqual(transaction.status(), { type: "committed" });
    });
  });
});

describe("sinkGuard transactions", () => {

  it("should throw if transactions are committed out of order", () => {
    const { sink, setTransaction } = createScriptedSink();
    const guarded = sinkGuard({ sink });

    guarded.write({ chunks: textChunks({ texts: ["a"] }) });
    const second = guarded.write({ chunks: textChunks({ texts: ["b"] }) });
    setTransaction({ index: 1, type: "committed" });

    assert.throws(() => {
      second.status();
    }, /contract violation: sink: transactions MUST be committed in the order they were written/);
  });

  it("should throw if a transaction is discarded while the sink is neither failed nor destroyed", () => {
    const { sink, setTransaction } = createScriptedSink();
    const transaction = sinkGuard({ sink }).write({ chunks: textChunks({ texts: ["a"] }) });

    setTransaction({ index: 0, type: "discarded" });

    assert.throws(() => {
      transaction.status();
    }, /contract violation: sink: a transaction MUST NOT be discarded in status open/);
  });

  it("should accept a transaction that is discarded once the sink failed", () => {
    const { sink, setStatus, setTransaction } = createScriptedSink();
    const transaction = sinkGuard({ sink }).write({ chunks: textChunks({ texts: ["a"] }) });

    setStatus({ type: "failed" });
    setTransaction({ index: 0, type: "discarded" });

    assert.deepEqual(transaction.status(), { type: "discarded" });
  });

  it("should throw if a transaction is still pending in a final status", () => {
    const { sink, setStatus } = createScriptedSink();
    const guarded = sinkGuard({ sink });

    guarded.write({ chunks: textChunks({ texts: ["a"] }) });
    setStatus({ type: "failed" });

    assert.throws(() => {
      guarded.status();
    }, /contract violation: sink: transactions MUST NOT be pending in status failed/);
  });

  it("should throw if finished is entered before all transactions have been committed", () => {
    const { sink, setStatus, setTransaction } = createScriptedSink();
    const guarded = sinkGuard({ sink });

    guarded.write({ chunks: textChunks({ texts: ["a"] }) });
    setTransaction({ index: 0, type: "discarded" });
    setStatus({ type: "finished" });

    assert.throws(() => {
      guarded.status();
    }, /contract violation: sink: finished MUST NOT be entered before all transactions have been committed/);
  });

  it("should throw on a transaction status transition that is not allowed", () => {
    const { sink, setStatus, setTransaction } = createScriptedSink();
    const transaction = sinkGuard({ sink }).write({ chunks: textChunks({ texts: ["a"] }) });

    setStatus({ type: "failed" });
    setTransaction({ index: 0, type: "discarded" });
    transaction.status();
    setTransaction({ index: 0, type: "committed" });

    assert.throws(() => {
      transaction.status();
    }, /contract violation: sink transaction: status discarded MUST NOT change to committed/);
  });
});
