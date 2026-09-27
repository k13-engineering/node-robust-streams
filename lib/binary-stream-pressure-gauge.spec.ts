import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createBinaryStreamPressureGauge } from "./binary-stream-pressure-gauge.ts";
import { fixedChunksSource } from "./fixed-chunks-source.ts";
import { pump } from "./pump.ts";
import type { TSinkStreamWriteTransactionStatus } from "./sink-stream.ts";
import type { TBinaryStreamChunk } from "./stream-chunk.ts";
import { createControllableSink } from "./test-helpers.spec.ts";

// a transaction whose status is set by the test
const createTransaction = () => {
  let type: TSinkStreamWriteTransactionStatus["type"] = "pending";

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

const bytes = ({ lengths }: { lengths: readonly number[] }) => {
  return lengths.map((length) => {
    return { data: new Uint8Array(length) };
  });
};

// reports a pending transaction with chunks of the given lengths, returns the transaction to change its status
const reportPending = ({
  gauge,
  lengths
}: {
  gauge: ReturnType<typeof createBinaryStreamPressureGauge>;
  lengths: readonly number[];
}) => {
  const transaction = createTransaction();
  gauge.report({ transaction: transaction.transaction, chunks: bytes({ lengths }) });
  return transaction;
};

describe("createBinaryStreamPressureGauge", () => {

  it("should throw if the low watermark is above the high watermark", () => {
    assert.throws(() => {
      createBinaryStreamPressureGauge({ lowWatermark: 2, highWatermark: 1 });
    }, /contract violation: the low watermark \(2\) MUST NOT be above the high watermark \(1\)/);
  });

  it("should be below the low watermark without pending bytes, also with a low watermark of 0", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 0, highWatermark: 0 });

    assert.deepEqual(gauge.status(), { type: "below-low-watermark", pendingBytes: 0 });
  });

  it("should sum up the bytes of all chunks of all pending transactions", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 100, highWatermark: 200 });

    reportPending({ gauge, lengths: [3, 4] });
    reportPending({ gauge, lengths: [5] });

    assert.equal(gauge.status().pendingBytes, 12);
  });

  it("should only be above a watermark with more pending bytes than the watermark", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 4, highWatermark: 8 });

    reportPending({ gauge, lengths: [4] });
    assert.deepEqual(gauge.status(), { type: "below-low-watermark", pendingBytes: 4 });

    reportPending({ gauge, lengths: [4] });
    assert.deepEqual(gauge.status(), { type: "above-low-watermark", pendingBytes: 8 });

    reportPending({ gauge, lengths: [1] });
    assert.deepEqual(gauge.status(), { type: "above-high-watermark", pendingBytes: 9 });
  });

  it("should stop counting transactions once they are committed or discarded", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 4, highWatermark: 8 });
    const committed = reportPending({ gauge, lengths: [6] });
    const discarded = reportPending({ gauge, lengths: [2] });
    reportPending({ gauge, lengths: [1] });

    assert.equal(gauge.status().type, "above-high-watermark");

    committed.set({ to: "committed" });
    discarded.set({ to: "discarded" });

    assert.deepEqual(gauge.status(), { type: "below-low-watermark", pendingBytes: 1 });
  });

  it("should yield frozen status objects", () => {
    assert.ok(Object.isFrozen(createBinaryStreamPressureGauge({ lowWatermark: 1, highWatermark: 2 }).status()));
  });
});

describe("createBinaryStreamPressureGauge reportPumpResult", () => {

  it("should report the transaction of a pump result together with its chunks", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 100, highWatermark: 200 });
    const source = fixedChunksSource({ chunks: bytes({ lengths: [5, 7] }), maxPerTurn: 1 });
    const { sink, commit } = createControllableSink<TBinaryStreamChunk>({ initial: "open" });

    gauge.reportPumpResult({ pumpResult: pump({ from: source, to: sink }) });
    gauge.reportPumpResult({ pumpResult: pump({ from: source, to: sink }) });
    assert.equal(gauge.status().pendingBytes, 12);

    commit({ count: 1 });
    assert.equal(gauge.status().pendingBytes, 7);
  });

  it("should ignore a pump result without transaction", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 100, highWatermark: 200 });
    const { sink } = createControllableSink<TBinaryStreamChunk>({ initial: "opening" });
    const result = pump({ from: fixedChunksSource({ chunks: bytes({ lengths: [5] }) }), to: sink });

    gauge.reportPumpResult({ pumpResult: result });

    assert.equal(result.transaction, undefined);
    assert.equal(gauge.status().pendingBytes, 0);
  });
});

describe("createBinaryStreamPressureGauge takesMore", () => {

  it("should take more until more bytes than the high watermark are pending", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 4, highWatermark: 8 });

    assert.equal(gauge.takesMore(), true);

    reportPending({ gauge, lengths: [8] });
    assert.equal(gauge.takesMore(), true);

    reportPending({ gauge, lengths: [1] });
    assert.equal(gauge.takesMore(), false);
  });

  it("should not take more again until at most the low watermark is pending", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 4, highWatermark: 8 });
    const first = reportPending({ gauge, lengths: [2] });
    const second = reportPending({ gauge, lengths: [3] });
    reportPending({ gauge, lengths: [4] });

    assert.equal(gauge.takesMore(), false);

    first.set({ to: "committed" });
    assert.equal(gauge.status().type, "above-low-watermark");
    assert.equal(gauge.takesMore(), false);

    second.set({ to: "committed" });
    assert.equal(gauge.takesMore(), true);
  });

  it("should take more while rising from below the low watermark up to the high watermark", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 4, highWatermark: 8 });

    reportPending({ gauge, lengths: [6] });

    assert.equal(gauge.status().type, "above-low-watermark");
    assert.equal(gauge.takesMore(), true);
  });

  it("should notice a report exceeding the high watermark, even if takesMore() was not called in between", () => {
    const gauge = createBinaryStreamPressureGauge({ lowWatermark: 4, highWatermark: 8 });
    const first = reportPending({ gauge, lengths: [5] });
    reportPending({ gauge, lengths: [5] });

    first.set({ to: "committed" });

    assert.equal(gauge.status().type, "above-low-watermark");
    assert.equal(gauge.takesMore(), false);
  });
});
