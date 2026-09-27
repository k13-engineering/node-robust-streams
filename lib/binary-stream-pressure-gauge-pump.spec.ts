import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createBinaryStreamPressureGaugePump } from "./binary-stream-pressure-gauge-pump.ts";
import { fixedChunksSource } from "./fixed-chunks-source.ts";
import { sinkGuard } from "./sink-stream.ts";
import { sourceGuard } from "./source-stream.ts";
import type { TBinaryStreamChunk } from "./stream-chunk.ts";
import { syncSink } from "./sync-sink.ts";
import {
  createControllableSink,
  createControllableSource,
  nextTasks
} from "./test-helpers.spec.ts";

const bytes = ({ lengths }: { lengths: readonly number[] }) => {
  return lengths.map((length) => {
    return { data: new Uint8Array(length) };
  });
};

const createCounter = () => {
  let calls = 0;

  return {
    onUpdate: () => {
      calls += 1;
    },
    calls: () => {
      return calls;
    }
  };
};

// a source handing out one chunk per read(), a sink whose transactions stay pending until committed by the test
// and a gauge pump with a low watermark of 4 and a high watermark of 8 bytes
const setup = ({ lengths }: { lengths: readonly number[] }) => {
  const source = sourceGuard({ source: fixedChunksSource({ chunks: bytes({ lengths }), maxPerTurn: 1 }) });
  const { sink: controllable, commit, set, writes } = createControllableSink<TBinaryStreamChunk>({ initial: "open" });
  const sink = sinkGuard({ sink: controllable });
  const gaugePump = createBinaryStreamPressureGaugePump({ lowWatermark: 4, highWatermark: 8 });

  return {
    source,
    sink,
    commit,
    set,
    writes,
    maybePumpNext: () => {
      return gaugePump.maybePump({ from: source, to: sink });
    }
  };
};

describe("createBinaryStreamPressureGaugePump", () => {

  it("should pump while the gauge takes more and return the transaction of to", () => {
    const { maybePumpNext, writes, commit } = setup({ lengths: [5] });
    const result = maybePumpNext();

    assert.deepEqual(writes(), [bytes({ lengths: [5] })]);
    commit({ count: 1 });
    assert.deepEqual(result.transaction?.status(), { type: "committed" });
  });

  it("should not pump anymore once above the high watermark, until at most the low watermark is pending again", () => {
    const { maybePumpNext, writes, commit } = setup({ lengths: [5, 5, 5] });

    assert.notEqual(maybePumpNext().transaction, undefined);
    assert.notEqual(maybePumpNext().transaction, undefined);

    assert.equal(maybePumpNext().transaction, undefined);
    assert.equal(writes().length, 2);

    commit({ count: 1 });
    assert.equal(maybePumpNext().transaction, undefined);

    commit({ count: 1 });
    assert.notEqual(maybePumpNext().transaction, undefined);
    assert.equal(writes().length, 3);
  });

  it("should wait for to while not pumping and call onUpdate once to committed", async () => {
    const { maybePumpNext, commit } = setup({ lengths: [9, 1] });
    const counter = createCounter();

    maybePumpNext();
    maybePumpNext().poll({ onUpdate: counter.onUpdate });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 0);

    commit({ count: 1 });
    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });

  it("should decide what to wait for when poll() is called, so a gauge taking more again calls onUpdate right away", async () => {
    const { maybePumpNext, commit } = setup({ lengths: [9, 1] });
    const counter = createCounter();

    maybePumpNext();
    const result = maybePumpNext();

    commit({ count: 1 });
    result.poll({ onUpdate: counter.onUpdate });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });

  it("should call onUpdate right away while not pumping, once a stream broke", async () => {
    const { maybePumpNext, set } = setup({ lengths: [9, 1] });
    const counter = createCounter();

    maybePumpNext();
    const result = maybePumpNext();

    set({ type: "failing" });
    result.poll({ onUpdate: counter.onUpdate });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });

  it("should end to once from will not provide chunks anymore, even while above the high watermark", () => {
    const { source, set: setSource, provide } = createControllableSource<TBinaryStreamChunk>({ initial: "open" });
    const { sink } = createControllableSink<TBinaryStreamChunk>({ initial: "open" });
    const gaugePump = createBinaryStreamPressureGaugePump({ lowWatermark: 4, highWatermark: 8 });
    const from = sourceGuard({ source });
    const to = sinkGuard({ sink });

    provide({ chunks: bytes({ lengths: [9] }) });
    gaugePump.maybePump({ from, to });
    setSource({ type: "ended" });

    assert.equal(gaugePump.maybePump({ from, to }).transaction, undefined);
    assert.deepEqual(to.status(), { type: "finishing" });
  });

  it("should throw a contract violation for statuses pump() MUST NOT be called in, also while not pumping", () => {
    const { maybePumpNext, set } = setup({ lengths: [9, 1] });

    maybePumpNext();
    set({ type: "finishing" });

    assert.throws(() => {
      maybePumpNext();
    }, /contract violation: pump\(\) MUST NOT be called when to is in status finishing/);
  });

  it("should keep track of the transactions of all calls, e.g. of multiple sources pumped into the same sink", () => {
    const { sink: controllable, writes } = createControllableSink<TBinaryStreamChunk>({ initial: "open" });
    const sink = sinkGuard({ sink: controllable });
    const first = sourceGuard({ source: fixedChunksSource({ chunks: bytes({ lengths: [5, 5] }), maxPerTurn: 1 }) });
    const second = sourceGuard({ source: fixedChunksSource({ chunks: bytes({ lengths: [5] }) }) });
    const gaugePump = createBinaryStreamPressureGaugePump({ lowWatermark: 4, highWatermark: 8 });

    gaugePump.maybePump({ from: first, to: sink });
    gaugePump.maybePump({ from: second, to: sink });

    assert.equal(gaugePump.maybePump({ from: first, to: sink }).transaction, undefined);
    assert.equal(writes().length, 2);
  });

  it("should keep the transaction status type of to", () => {
    const sink = syncSink({
      write: ({ chunks }: { chunks: readonly TBinaryStreamChunk[] }) => {
        return { error: undefined, transaction: { bytes: chunks[0].data.byteLength } };
      },
      finish: () => {
        return { error: undefined };
      },
      destroy: () => {
        return {};
      }
    });
    const gaugePump = createBinaryStreamPressureGaugePump({ lowWatermark: 4, highWatermark: 8 });
    const from = fixedChunksSource({ chunks: bytes({ lengths: [3] }) });
    const transactionStatus = gaugePump.maybePump({ from, to: sink }).transaction?.status();

    const written: number = transactionStatus?.type === "committed" ? transactionStatus.bytes : 0;

    assert.equal(written, 3);
  });
});
