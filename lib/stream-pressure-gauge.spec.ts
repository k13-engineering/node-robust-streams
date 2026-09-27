import assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { TSinkStreamWriteTransactionStatus } from "./sink-stream.ts";
import { createStreamPressureGauge } from "./stream-pressure-gauge.ts";

// a transaction whose status is set by the test
const createTransaction = ({ initial }: { initial: TSinkStreamWriteTransactionStatus["type"] }) => {
  let type = initial;

  return {
    transaction: {
      status: () => {
        return { type };
      }
    },
    set: ({ to }: { to: TSinkStreamWriteTransactionStatus["type"] }) => {
      type = to;
    }
  };
};

describe("createStreamPressureGauge", () => {

  it("should have no pending transactions initially", () => {
    assert.deepEqual(createStreamPressureGauge().pending(), []);
  });

  it("should return the reported transactions that are still pending, in the order they were reported", () => {
    const gauge = createStreamPressureGauge();
    const first = createTransaction({ initial: "pending" });
    const second = createTransaction({ initial: "pending" });

    gauge.report({ transaction: first.transaction });
    gauge.report({ transaction: second.transaction });

    assert.deepEqual(gauge.pending(), [first.transaction, second.transaction]);
  });

  it("should remove transactions once they are not pending anymore", () => {
    const gauge = createStreamPressureGauge();
    const committed = createTransaction({ initial: "pending" });
    const discarded = createTransaction({ initial: "pending" });
    const stillPending = createTransaction({ initial: "pending" });

    [committed, discarded, stillPending].forEach(({ transaction }) => {
      gauge.report({ transaction });
    });

    committed.set({ to: "committed" });
    discarded.set({ to: "discarded" });

    assert.deepEqual(gauge.pending(), [stillPending.transaction]);
  });

  it("should never report a removed transaction again", () => {
    const gauge = createStreamPressureGauge();
    const transaction = createTransaction({ initial: "committed" });

    gauge.report({ transaction: transaction.transaction });
    assert.deepEqual(gauge.pending(), []);

    transaction.set({ to: "pending" });
    assert.deepEqual(gauge.pending(), []);
  });
});
