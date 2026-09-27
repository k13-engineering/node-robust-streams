import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { fixedChunksSource } from "./fixed-chunks-source.ts";
import { nullSink } from "./null-sink.ts";
import { assertPumpable, pump, runPump } from "./pump.ts";
import { sinkGuard } from "./sink-stream.ts";
import { sourceGuard } from "./source-stream.ts";
import {
  createAutoSink,
  createControllableSink,
  createControllableSource,
  deferOnUpdate,
  nextTasks,
  textChunks
} from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";
import { syncSource } from "./sync-source.ts";
import { syncDuplex } from "./sync-duplex.ts";
import { duplexGuard } from "./duplex-stream.ts";

const guardedPair = ({ from, to }: { from: "opening" | "open" | "ended"; to: "opening" | "open" }) => {
  const source = createControllableSource<TTextChunk>({ initial: from });
  const sink = createControllableSink<TTextChunk>({ initial: to });

  return {
    ...source,
    ...sink,
    source: sourceGuard({ source: source.source }),
    sink: sinkGuard({ sink: sink.sink })
  };
};

const upperCase = () => {
  return duplexGuard({
    duplex: syncDuplex<TTextChunk, TTextChunk>({
      transform: ({ chunks }) => {
        return {
          chunks: chunks.map((chunk) => {
            return { text: chunk.text.toUpperCase() };
          })
        };
      }
    })
  });
};

describe("pump", () => {

  describe("allowed statuses", () => {
    it("should throw when from is in a status pump() MUST NOT be called in", () => {
      const forbidden = ["failing", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        const from = createControllableSource<TTextChunk>({ initial: type }).source;
        const to = createControllableSink<TTextChunk>({ initial: "open" }).sink;

        assert.throws(() => {
          pump({ from, to });
        }, new RegExp(`contract violation: pump\\(\\) MUST NOT be called when from is in status ${type}`));
      });
    });

    it("should throw when to is in a status pump() MUST NOT be called in", () => {
      const forbidden = ["finishing", "finished", "failing", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        const from = createControllableSource<TTextChunk>({ initial: "open" }).source;
        const to = createControllableSink<TTextChunk>({ initial: type }).sink;

        assert.throws(() => {
          pump({ from, to });
        }, new RegExp(`contract violation: pump\\(\\) MUST NOT be called when to is in status ${type}`));
      });
    });
  });

  describe("results", () => {
    it("should return no transaction and neither read nor write while to is opening", () => {
      const { source, sink, provide, writes } = guardedPair({ from: "open", to: "opening" });

      provide({ chunks: textChunks({ texts: ["a"] }) });

      assert.equal(pump({ from: source, to: sink }).transaction, undefined);
      assert.deepEqual(writes(), []);
    });

    it("should return no transaction while from is opening", () => {
      const { source, sink, writes } = guardedPair({ from: "opening", to: "open" });

      assert.equal(pump({ from: source, to: sink }).transaction, undefined);
      assert.deepEqual(writes(), []);
    });

    it("should return no transaction and no chunks if from has nothing to read", () => {
      const { source, sink, writes } = guardedPair({ from: "open", to: "open" });
      const result = pump({ from: source, to: sink });

      assert.equal(result.transaction, undefined);
      assert.deepEqual(result.chunks, []);
      assert.deepEqual(writes(), []);
    });

    it("should move all chunks from can provide to to and return the transaction of to", () => {
      const { source, sink, provide, writes, commit } = guardedPair({ from: "open", to: "open" });

      provide({ chunks: textChunks({ texts: ["a", "b"] }) });
      const result = pump({ from: source, to: sink });

      assert.deepEqual(writes(), [textChunks({ texts: ["a", "b"] })]);
      assert.deepEqual(result.chunks, textChunks({ texts: ["a", "b"] }));

      commit({ count: 1 });
      assert.deepEqual(result.transaction?.status(), { type: "committed" });
    });

    it("should end to without a transaction once from will not provide chunks anymore", () => {
      const { source, sink } = guardedPair({ from: "ended", to: "open" });
      const result = pump({ from: source, to: sink });

      assert.equal(result.transaction, undefined);
      assert.deepEqual(result.chunks, []);
      assert.deepEqual(sink.status(), { type: "finishing" });
    });

    it("should only end to with the call after the one writing the last chunks", () => {
      const first = upperCase();
      const second = upperCase();

      first.write({ chunks: textChunks({ texts: ["a"] }) });
      first.end();

      assert.notEqual(pump({ from: first, to: second }).transaction, undefined);
      assert.deepEqual(first.status(), { type: "done" });
      assert.deepEqual(second.status(), { type: "open" });

      assert.equal(pump({ from: first, to: second }).transaction, undefined);
      assert.deepEqual(second.status(), { type: "flushing" });
      assert.deepEqual(second.read(), { chunks: textChunks({ texts: ["A"] }) });
    });
  });
});

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

describe("pump poll", () => {

  it("should poll to while to is opening, even if from has data, and never call onUpdate synchronously", async () => {
    const { source, sink, provide, set } = guardedPair({ from: "open", to: "opening" });
    const counter = createCounter();

    provide({ chunks: textChunks({ texts: ["a"] }) });
    pump({ from: source, to: sink }).poll({ onUpdate: counter.onUpdate });
    assert.equal(counter.calls(), 0);

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 0);

    set({ type: "open" });
    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });

  it("should poll from while from has nothing to read", async () => {
    const { source, sink, provide } = guardedPair({ from: "open", to: "open" });
    const counter = createCounter();

    pump({ from: source, to: sink }).poll({ onUpdate: counter.onUpdate });
    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 0);

    provide({ chunks: textChunks({ texts: ["a"] }) });
    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });

  it("should poll from after writing, which triggers right away while from has more to read", async () => {
    const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b"] }), maxPerTurn: 1 }) });
    const sink = sinkGuard({ sink: nullSink<TTextChunk>() });
    const counter = createCounter();
    const result = pump({ from: source, to: sink });

    assert.notEqual(result.transaction, undefined);
    result.poll({ onUpdate: counter.onUpdate });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });

  it("should call onUpdate right away once the next call can end to", async () => {
    const from = upperCase();
    const to = sinkGuard({ sink: nullSink<TTextChunk>() });
    const counter = createCounter();

    from.write({ chunks: textChunks({ texts: ["a"] }) });
    from.end();
    pump({ from, to }).poll({ onUpdate: counter.onUpdate });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
    assert.equal(pump({ from, to }).transaction, undefined);
    assert.deepEqual(to.status(), { type: "finished", chunksWritten: 1 });
  });

  it("should call onUpdate right away once a stream broke, so the caller notices", async () => {
    const source = sourceGuard({
      source: syncSource<TTextChunk>({
        read: () => {
          return { error: Error("read failed"), chunks: undefined, end: undefined };
        }
      })
    });
    const sink = sinkGuard({ sink: nullSink<TTextChunk>() });
    const counter = createCounter();

    pump({ from: source, to: sink }).poll({ onUpdate: counter.onUpdate });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
    assert.deepEqual(source.status(), { type: "failed" });
  });
});

describe("pump poll handle", () => {

  it("should offer a poll also once to has been ended, which calls onUpdate right away without polling to", async () => {
    const source = sourceGuard({ source: fixedChunksSource<TTextChunk>({ chunks: [] }) });
    const sink = sinkGuard({ sink: nullSink<TTextChunk>() });
    const counter = createCounter();
    const result = pump({ from: source, to: sink });

    assert.deepEqual(sink.status(), { type: "finished", chunksWritten: 0 });

    // the guard throws if a finished sink is polled
    result.poll({ onUpdate: counter.onUpdate });
    assert.equal(counter.calls(), 0);

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });

  it("should return the poll handle, which allows to cancel the poll", async () => {
    const { source, sink, provide } = guardedPair({ from: "open", to: "open" });
    const counter = createCounter();

    const handle = pump({ from: source, to: sink }).poll({ onUpdate: counter.onUpdate });
    handle.cancel();
    provide({ chunks: textChunks({ texts: ["a"] }) });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 0);
    assert.deepEqual(handle.status(), { type: "cancelled" });
  });

  it("should decide what to wait for when poll() is called, not when pump() returned", async () => {
    const { source, sink, provide, set } = guardedPair({ from: "open", to: "opening" });
    const counter = createCounter();
    const result = pump({ from: source, to: sink });

    provide({ chunks: textChunks({ texts: ["a"] }) });
    set({ type: "open" });
    result.poll({ onUpdate: counter.onUpdate });

    await nextTasks({ count: 2 });
    assert.equal(counter.calls(), 1);
  });
});

describe("assertPumpable", () => {

  it("should accept all combinations of from and to in opening or open", () => {
    const fromTypes = ["opening", "open"] as const;
    const toTypes = ["opening", "open"] as const;

    fromTypes.forEach((fromType) => {
      toTypes.forEach((toType) => {
        assertPumpable({ fromStatus: { type: fromType }, toStatus: { type: toType } });
      });
    });
  });

  it("should reject statuses pump() MUST NOT be called in, when compiling and at runtime", () => {
    assert.throws(() => {
      // @ts-expect-error failed is no status pump() may be called in
      assertPumpable({ fromStatus: { type: "failed" }, toStatus: { type: "open" } });
    }, /contract violation: pump\(\) MUST NOT be called when from is in status failed/);

    assert.throws(() => {
      // @ts-expect-error finished is no status pump() may be called in
      assertPumpable({ fromStatus: { type: "open" }, toStatus: { type: "finished" } });
    }, /contract violation: pump\(\) MUST NOT be called when to is in status finished/);
  });

  (["ending", "ended", "flushing", "done"] as const).forEach((type) => {
    it(`should reject from in ${type}, although pump() may be called in it, when compiling and at runtime`, () => {
      assert.throws(() => {
        // @ts-expect-error from has to be opening or open
        assertPumpable({ fromStatus: { type }, toStatus: { type: "open" } });
      }, { message: `contract violation: from MUST be opening or open for assertPumpable(), but is in status ${type}` });
    });
  });

  it("should only compile once all statuses but opening and open have been narrowed away", () => {
    const fromStatus = fixedChunksSource({ chunks: textChunks({ texts: ["a"] }) }).status();
    const toStatus = nullSink<TTextChunk>().status();

    // @ts-expect-error ended, failed and destroyed of from as well as finished, failed and destroyed of to are not handled
    assertPumpable({ fromStatus, toStatus });

    if (fromStatus.type !== "open" || toStatus.type !== "open") {
      assert.fail(`unexpected statuses ${fromStatus.type} and ${toStatus.type}`);
    }

    // the open status of the fixed chunks source carries own properties, it fits nevertheless
    assertPumpable({ fromStatus, toStatus });
  });
});

describe("runPump", () => {

  it("should pump everything and resolve once to is finished", async () => {
    const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b"] }) }) });
    const { sink, writes } = createAutoSink<TTextChunk>();

    assert.deepEqual(await runPump({ from: source, to: sinkGuard({ sink }) }), { type: "finished" });
    assert.deepEqual(writes(), [textChunks({ texts: ["a", "b"] })]);
  });

  it("should resolve once from broke, without ending or destroying to", async () => {
    const source = createControllableSource<TTextChunk>({ initial: "open" });
    const sink = createControllableSink<TTextChunk>({ initial: "open" });
    const result = runPump({ from: source.source, to: sink.sink });

    await nextTasks({ count: 2 });
    source.set({ type: "failing" });

    assert.deepEqual(await result, { type: "failed", side: "from" });
    assert.deepEqual(sink.sink.status(), { type: "open" });
  });

  it("should resolve once to broke, without destroying from", async () => {
    const source = createControllableSource<TTextChunk>({ initial: "open" });
    const sink = createControllableSink<TTextChunk>({ initial: "open" });
    const result = runPump({ from: source.source, to: sink.sink });

    await nextTasks({ count: 2 });
    sink.set({ type: "failing" });

    assert.deepEqual(await result, { type: "failed", side: "to" });
    assert.deepEqual(source.source.status(), { type: "open" });
  });

  it("should pump through a duplex", async () => {
    const duplex = upperCase();
    const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b"] }) }) });
    const { sink, writes } = createAutoSink<TTextChunk>();

    const results = await Promise.all([
      runPump({ from: source, to: duplex }),
      runPump({ from: duplex, to: sinkGuard({ sink }) })
    ]);

    assert.deepEqual(results, [{ type: "finished" }, { type: "finished" }]);
    assert.deepEqual(writes(), [textChunks({ texts: ["A", "B"] })]);
  });

  it("should not poll a stream that pump() broke synchronously", async () => {
    const source = sourceGuard({
      source: syncSource<TTextChunk>({
        read: () => {
          return { error: Error("read failed"), chunks: undefined, end: undefined };
        }
      })
    });

    assert.deepEqual(await runPump({ from: source, to: sinkGuard({ sink: createAutoSink<TTextChunk>().sink }) }), {
      type: "failed",
      side: "from"
    });
  });

  it("should end to right after writing the last chunks, although neither from nor to will trigger a poll anymore", async () => {
    const from = upperCase();
    from.write({ chunks: textChunks({ texts: ["a"] }) });
    from.end();

    // the duplex is done with the read() handing out its last output, the null sink commits synchronously
    const result = await runPump({ from, to: sinkGuard({ sink: nullSink<TTextChunk>() }) });

    assert.deepEqual(result, { type: "finished" });
  });

  it("should wait for to to open before ending it", async () => {
    const { source, sink, set } = guardedPair({ from: "ended", to: "opening" });
    const result = runPump({ from: source, to: sink });

    await nextTasks({ count: 2 });
    set({ type: "open" });
    await nextTasks({ count: 2 });
    assert.deepEqual(sink.status(), { type: "finishing" });

    set({ type: "finished" });
    assert.deepEqual(await result, { type: "finished" });
  });
});

describe("runPump flow control", () => {

  it("should not have more than maxPending transactions pending", async () => {
    const { source, sink, provide, commit, writes } = guardedPair({ from: "open", to: "open" });
    runPump({ from: source, to: sink, maxPending: 1 });

    provide({ chunks: textChunks({ texts: ["a"] }) });
    await nextTasks({ count: 3 });
    provide({ chunks: textChunks({ texts: ["b"] }) });
    await nextTasks({ count: 3 });
    assert.equal(writes().length, 1);

    commit({ count: 1 });
    await nextTasks({ count: 3 });
    assert.equal(writes().length, 2);
  });

  it("should handle polls that were both triggered before their onUpdate is called", async () => {
    const source = createControllableSource<TTextChunk>({ initial: "open" });
    const sink = createControllableSink<TTextChunk>({ initial: "opening" });
    const result = runPump({ from: deferOnUpdate({ stream: source.source }), to: deferOnUpdate({ stream: sink.sink }) });

    await nextTasks({ count: 2 });
    source.provide({ chunks: textChunks({ texts: ["a"] }) });
    sink.set({ type: "open" });
    await nextTasks({ count: 6 });
    assert.deepEqual(sink.writes(), [textChunks({ texts: ["a"] })]);

    sink.commit({ count: 1 });
    source.set({ type: "ended" });
    await nextTasks({ count: 6 });
    sink.set({ type: "finished" });

    assert.deepEqual(await result, { type: "finished" });
  });
});
