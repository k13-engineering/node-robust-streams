import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { syncTransform } from "./sync-transform.ts";
import type { TSyncTransformResult } from "./sync-transform.ts";
import { nextTask, textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";
import { transformGuard } from "./transform-stream.ts";

const texts = ({ result }: { result: { chunks: readonly TTextChunk[] } }) => {
  return result.chunks.map((chunk) => {
    return chunk.text;
  });
};

// upper cases all chunks and drops chunks with text "drop", start and finish can be replaced
const upperCaseTransform = ({
  start,
  finish
}: {
  start?: () => TSyncTransformResult<TTextChunk>;
  finish?: () => TSyncTransformResult<TTextChunk>;
}) => {
  return transformGuard({
    transform: syncTransform<TTextChunk, TTextChunk>({
      start,
      finish,
      transform: ({ chunks }) => {
        return {
          chunks: chunks.filter((chunk) => {
            return chunk.text !== "drop";
          }).map((chunk) => {
            return { text: chunk.text.toUpperCase() };
          })
        };
      }
    })
  });
};

describe("syncTransform", () => {

  describe("transforming", () => {
    it("should transform written chunks synchronously", () => {
      const transform = upperCaseTransform({});

      transform.write({ chunks: textChunks({ texts: ["a", "drop"] }) });
      transform.write({ chunks: textChunks({ texts: ["b"] }) });

      assert.deepEqual(texts({ result: transform.read() }), ["A", "B"]);
    });

    it("should call start once, before the first chunks are transformed", () => {
      const transform = upperCaseTransform({
        start: () => {
          return { chunks: textChunks({ texts: ["start"] }) };
        }
      });

      transform.write({ chunks: textChunks({ texts: ["a"] }) });
      transform.write({ chunks: textChunks({ texts: ["b"] }) });

      assert.deepEqual(texts({ result: transform.read() }), ["start", "A", "B"]);
    });

    it("should call start and finish on end() if nothing was written", () => {
      const transform = upperCaseTransform({
        start: () => {
          return { chunks: textChunks({ texts: ["start"] }) };
        },
        finish: () => {
          return { chunks: textChunks({ texts: ["finish"] }) };
        }
      });

      transform.end();

      assert.deepEqual(texts({ result: transform.read() }), ["start", "finish"]);
    });

    it("should trigger a poll asynchronously once there is output to read", async () => {
      const transform = upperCaseTransform({});
      let calls = 0;

      transform.poll({
        onUpdate: () => {
          calls += 1;
        }
      });
      transform.write({ chunks: textChunks({ texts: ["a"] }) });
      assert.equal(calls, 0);

      await nextTask();
      assert.equal(calls, 1);
    });

    it("should hand out frozen read results", () => {
      const transform = upperCaseTransform({});

      transform.write({ chunks: textChunks({ texts: ["a"] }) });

      assert.ok(Object.isFrozen(transform.read().chunks));
    });
  });

  describe("end", () => {
    it("should be done right away when ended without output left to read", () => {
      const transform = upperCaseTransform({});

      transform.end();

      assert.deepEqual(transform.status(), { type: "done" });
    });

    it("should be flushing until the output of finish has been read", () => {
      const transform = upperCaseTransform({
        finish: () => {
          return { chunks: textChunks({ texts: ["finish"] }) };
        }
      });

      transform.end();
      assert.deepEqual(transform.status(), { type: "flushing" });

      assert.deepEqual(texts({ result: transform.read() }), ["finish"]);
      assert.deepEqual(transform.status(), { type: "done" });
    });
  });
});

describe("syncTransform transactions", () => {

  it("should commit a transaction once its output has been read", () => {
    const transform = upperCaseTransform({});
    const transaction = transform.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(transaction.status(), { type: "pending" });
    transform.read();
    assert.deepEqual(transaction.status(), { type: "committed" });
  });

  it("should commit a transaction without output right away if nothing is waiting to be read", () => {
    const transform = upperCaseTransform({});

    assert.deepEqual(transform.write({ chunks: textChunks({ texts: ["drop"] }) }).status(), { type: "committed" });
  });

  it("should keep a transaction without output pending until the output of earlier ones has been read", () => {
    const transform = upperCaseTransform({});
    const first = transform.write({ chunks: textChunks({ texts: ["a"] }) });
    const second = transform.write({ chunks: textChunks({ texts: ["drop"] }) });

    assert.deepEqual([first.status(), second.status()], [{ type: "pending" }, { type: "pending" }]);
    transform.read();
    assert.deepEqual([first.status(), second.status()], [{ type: "committed" }, { type: "committed" }]);
  });

  it("should discard pending transactions when destroyed, but keep committed ones", () => {
    const transform = upperCaseTransform({});
    const committed = transform.write({ chunks: textChunks({ texts: ["a"] }) });
    transform.read();
    const pending = transform.write({ chunks: textChunks({ texts: ["b"] }) });

    transform.destroy();

    assert.deepEqual(transform.status(), { type: "destroyed" });
    assert.deepEqual([committed.status(), pending.status()], [{ type: "committed" }, { type: "discarded" }]);
  });
});

describe("syncTransform errors", () => {

  it("should fail and discard the transaction once transform returns an error", () => {
    const transform = transformGuard({
      transform: syncTransform<TTextChunk, TTextChunk>({
        transform: () => {
          return { error: Error("transform failed") };
        }
      })
    });

    const transaction = transform.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(transform.status(), { type: "failed" });
    assert.deepEqual(transaction.status(), { type: "discarded" });
  });

  it("should fail without transforming once start returns an error", () => {
    const transform = upperCaseTransform({
      start: () => {
        return { error: Error("start failed") };
      }
    });

    transform.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(transform.status(), { type: "failed" });
  });

  it("should fail once finish returns an error", () => {
    const transform = upperCaseTransform({
      finish: () => {
        return { error: Error("finish failed") };
      }
    });

    transform.end();

    assert.deepEqual(transform.status(), { type: "failed" });
  });

  it("should throw if transform returns neither error nor chunks", () => {
    const transform = syncTransform<TTextChunk, TTextChunk>({
      transform: () => {
        return {};
      }
    });

    assert.throws(() => {
      transform.write({ chunks: textChunks({ texts: ["a"] }) });
    }, /sync transform: start, transform and finish MUST return error or chunks/);
  });

  it("should not catch exceptions thrown by transform", () => {
    const transform = syncTransform<TTextChunk, TTextChunk>({
      transform: () => {
        throw Error("thrown by transform");
      }
    });

    assert.throws(() => {
      transform.write({ chunks: textChunks({ texts: ["a"] }) });
    }, /thrown by transform/);
  });
});
