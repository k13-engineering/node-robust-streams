import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { fixedChunksSource } from "./fixed-chunks-source.ts";
import { createPump, runPump } from "./pump.ts";
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
import { syncTransform } from "./sync-transform.ts";
import { transformGuard } from "./transform-stream.ts";

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
  return transformGuard({
    transform: syncTransform<TTextChunk, TTextChunk>({
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

describe("createPump", () => {

  describe("allowed statuses", () => {
    it("should throw when from is in a status pump() MUST NOT be called in", () => {
      const forbidden = ["failing", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        const from = createControllableSource<TTextChunk>({ initial: type }).source;
        const to = createControllableSink<TTextChunk>({ initial: "open" }).sink;

        assert.throws(() => {
          createPump({ from, to }).pump();
        }, new RegExp(`contract violation: pump\\(\\) MUST NOT be called when from is in status ${type}`));
      });
    });

    it("should throw when to is in a status pump() MUST NOT be called in", () => {
      const forbidden = ["finishing", "finished", "failing", "failed", "destroying", "destroyed"] as const;

      forbidden.forEach((type) => {
        const from = createControllableSource<TTextChunk>({ initial: "open" }).source;
        const to = createControllableSink<TTextChunk>({ initial: type }).sink;

        assert.throws(() => {
          createPump({ from, to }).pump();
        }, new RegExp(`contract violation: pump\\(\\) MUST NOT be called when to is in status ${type}`));
      });
    });
  });

  describe("pumping", () => {
    it("should neither read nor write while to is opening", () => {
      const { source, sink, provide, writes } = guardedPair({ from: "open", to: "opening" });

      provide({ chunks: textChunks({ texts: ["a"] }) });

      assert.deepEqual(createPump({ from: source, to: sink }).pump(), { done: false });
      assert.deepEqual(writes(), []);
    });

    it("should not read while from is opening", () => {
      const { source, sink, writes } = guardedPair({ from: "opening", to: "open" });

      assert.deepEqual(createPump({ from: source, to: sink }).pump(), { done: false });
      assert.deepEqual(writes(), []);
    });

    it("should move all chunks from can provide to to", () => {
      const { source, sink, provide, writes } = guardedPair({ from: "open", to: "open" });

      provide({ chunks: textChunks({ texts: ["a", "b"] }) });

      assert.deepEqual(createPump({ from: source, to: sink }).pump(), { done: false });
      assert.deepEqual(writes(), [textChunks({ texts: ["a", "b"] })]);
    });

    it("should not write if from has nothing to read", () => {
      const { source, sink, writes } = guardedPair({ from: "open", to: "open" });

      createPump({ from: source, to: sink }).pump();

      assert.deepEqual(writes(), []);
    });

    it("should end to once from will not provide chunks anymore", () => {
      const { source, sink } = guardedPair({ from: "ended", to: "open" });

      assert.deepEqual(createPump({ from: source, to: sink }).pump(), { done: true });
      assert.deepEqual(sink.status(), { type: "finishing" });
    });

    it("should end to right away once from ended while reading", () => {
      const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a"] }) }) });
      const { sink, writes } = createControllableSink<TTextChunk>({ initial: "open" });
      const pump = createPump({ from: source, to: sinkGuard({ sink }) });

      assert.deepEqual(pump.pump(), { done: false });
      assert.deepEqual(pump.pump(), { done: true });
      assert.deepEqual(writes(), [textChunks({ texts: ["a"] })]);
    });

    it("should return the transactions of to that are still pending", () => {
      const { source, sink, provide, commit } = guardedPair({ from: "open", to: "open" });
      const pump = createPump({ from: source, to: sink });

      provide({ chunks: textChunks({ texts: ["a"] }) });
      pump.pump();
      assert.equal(pump.pending().length, 1);

      commit({ count: 1 });
      assert.equal(pump.pending().length, 0);
    });

    it("should pump from a transform into a transform", () => {
      const first = upperCase();
      const second = upperCase();

      first.write({ chunks: textChunks({ texts: ["a"] }) });
      first.end();

      assert.deepEqual(createPump({ from: first, to: second }).pump(), { done: true });
      assert.deepEqual(second.read(), { chunks: textChunks({ texts: ["A"] }) });
    });
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

  it("should pump through a transform", async () => {
    const transform = upperCase();
    const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b"] }) }) });
    const { sink, writes } = createAutoSink<TTextChunk>();

    const results = await Promise.all([
      runPump({ from: source, to: transform }),
      runPump({ from: transform, to: sinkGuard({ sink }) })
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
