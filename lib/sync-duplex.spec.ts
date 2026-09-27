import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { syncDuplex } from "./sync-duplex.ts";
import type { TSyncDuplexResult } from "./sync-duplex.ts";
import { nextTask, textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";
import { duplexGuard } from "./duplex-stream.ts";

const texts = ({ result }: { result: { chunks: readonly TTextChunk[] } }) => {
  return result.chunks.map((chunk) => {
    return chunk.text;
  });
};

// upper cases all chunks and drops chunks with text "drop", start and finish can be replaced
const upperCaseDuplex = ({
  start,
  finish
}: {
  start?: () => TSyncDuplexResult<TTextChunk>;
  finish?: () => TSyncDuplexResult<TTextChunk>;
}) => {
  return duplexGuard({
    duplex: syncDuplex<TTextChunk, TTextChunk>({
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

describe("syncDuplex", () => {

  describe("transforming", () => {
    it("should transform written chunks synchronously", () => {
      const duplex = upperCaseDuplex({});

      duplex.write({ chunks: textChunks({ texts: ["a", "drop"] }) });
      duplex.write({ chunks: textChunks({ texts: ["b"] }) });

      assert.deepEqual(texts({ result: duplex.read() }), ["A", "B"]);
    });

    it("should call start once, before the first chunks are transformed", () => {
      const duplex = upperCaseDuplex({
        start: () => {
          return { chunks: textChunks({ texts: ["start"] }) };
        }
      });

      duplex.write({ chunks: textChunks({ texts: ["a"] }) });
      duplex.write({ chunks: textChunks({ texts: ["b"] }) });

      assert.deepEqual(texts({ result: duplex.read() }), ["start", "A", "B"]);
    });

    it("should call start and finish on end() if nothing was written", () => {
      const duplex = upperCaseDuplex({
        start: () => {
          return { chunks: textChunks({ texts: ["start"] }) };
        },
        finish: () => {
          return { chunks: textChunks({ texts: ["finish"] }) };
        }
      });

      duplex.end();

      assert.deepEqual(texts({ result: duplex.read() }), ["start", "finish"]);
    });

    it("should trigger a poll asynchronously once there is output to read", async () => {
      const duplex = upperCaseDuplex({});
      let calls = 0;

      duplex.poll({
        onUpdate: () => {
          calls += 1;
        }
      });
      duplex.write({ chunks: textChunks({ texts: ["a"] }) });
      assert.equal(calls, 0);

      await nextTask();
      assert.equal(calls, 1);
    });

    it("should hand out frozen read results", () => {
      const duplex = upperCaseDuplex({});

      duplex.write({ chunks: textChunks({ texts: ["a"] }) });

      assert.ok(Object.isFrozen(duplex.read().chunks));
    });
  });

  describe("end", () => {
    it("should be done right away when ended without output left to read", () => {
      const duplex = upperCaseDuplex({});

      duplex.end();

      assert.deepEqual(duplex.status(), { type: "done" });
    });

    it("should be flushing until the output of finish has been read", () => {
      const duplex = upperCaseDuplex({
        finish: () => {
          return { chunks: textChunks({ texts: ["finish"] }) };
        }
      });

      duplex.end();
      assert.deepEqual(duplex.status(), { type: "flushing" });

      assert.deepEqual(texts({ result: duplex.read() }), ["finish"]);
      assert.deepEqual(duplex.status(), { type: "done" });
    });
  });
});

describe("syncDuplex transactions", () => {

  it("should commit a transaction once its output has been read", () => {
    const duplex = upperCaseDuplex({});
    const transaction = duplex.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(transaction.status(), { type: "pending" });
    duplex.read();
    assert.deepEqual(transaction.status(), { type: "committed" });
  });

  it("should commit a transaction without output right away if nothing is waiting to be read", () => {
    const duplex = upperCaseDuplex({});

    assert.deepEqual(duplex.write({ chunks: textChunks({ texts: ["drop"] }) }).status(), { type: "committed" });
  });

  it("should keep a transaction without output pending until the output of earlier ones has been read", () => {
    const duplex = upperCaseDuplex({});
    const first = duplex.write({ chunks: textChunks({ texts: ["a"] }) });
    const second = duplex.write({ chunks: textChunks({ texts: ["drop"] }) });

    assert.deepEqual([first.status(), second.status()], [{ type: "pending" }, { type: "pending" }]);
    duplex.read();
    assert.deepEqual([first.status(), second.status()], [{ type: "committed" }, { type: "committed" }]);
  });

  it("should discard pending transactions when destroyed, but keep committed ones", () => {
    const duplex = upperCaseDuplex({});
    const committed = duplex.write({ chunks: textChunks({ texts: ["a"] }) });
    duplex.read();
    const pending = duplex.write({ chunks: textChunks({ texts: ["b"] }) });

    duplex.destroy();

    assert.deepEqual(duplex.status(), { type: "destroyed" });
    assert.deepEqual([committed.status(), pending.status()], [{ type: "committed" }, { type: "discarded" }]);
  });
});

describe("syncDuplex errors", () => {

  it("should fail and discard the transaction once transform returns an error", () => {
    const duplex = duplexGuard({
      duplex: syncDuplex<TTextChunk, TTextChunk>({
        transform: () => {
          return { error: Error("transform failed") };
        }
      })
    });

    const transaction = duplex.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(duplex.status(), { type: "failed" });
    assert.deepEqual(transaction.status(), { type: "discarded" });
  });

  it("should fail without transforming once start returns an error", () => {
    const duplex = upperCaseDuplex({
      start: () => {
        return { error: Error("start failed") };
      }
    });

    duplex.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(duplex.status(), { type: "failed" });
  });

  it("should fail once finish returns an error", () => {
    const duplex = upperCaseDuplex({
      finish: () => {
        return { error: Error("finish failed") };
      }
    });

    duplex.end();

    assert.deepEqual(duplex.status(), { type: "failed" });
  });

  it("should throw if transform returns neither error nor chunks", () => {
    const duplex = syncDuplex<TTextChunk, TTextChunk>({
      transform: () => {
        return {};
      }
    });

    assert.throws(() => {
      duplex.write({ chunks: textChunks({ texts: ["a"] }) });
    }, /sync duplex: start, transform and finish MUST return error or chunks/);
  });

  it("should not catch exceptions thrown by transform", () => {
    const duplex = syncDuplex<TTextChunk, TTextChunk>({
      transform: () => {
        throw Error("thrown by transform");
      }
    });

    assert.throws(() => {
      duplex.write({ chunks: textChunks({ texts: ["a"] }) });
    }, /thrown by transform/);
  });
});
