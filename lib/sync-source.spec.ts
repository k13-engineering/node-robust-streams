import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { sourceGuard } from "./source-stream.ts";
import { syncSource } from "./sync-source.ts";
import type { TSyncSourceReadArgs, TSyncSourceReadResult } from "./sync-source.ts";
import { nextTask, textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

// a sync source whose read function returns the given results one after another
const scriptedSyncSource = ({ results }: { results: readonly TSyncSourceReadResult<TTextChunk>[] }) => {
  let remaining = results;
  let calls: readonly TSyncSourceReadArgs[] = [];
  let destroyed = false;

  const source = sourceGuard({
    source: syncSource<TTextChunk>({
      read: (args) => {
        const [first, ...rest] = remaining;
        remaining = rest;
        calls = [...calls, args];
        return first;
      },
      destroy: () => {
        destroyed = true;
      }
    })
  });

  return {
    source,
    calls: () => {
      return calls;
    },
    destroyed: () => {
      return destroyed;
    }
  };
};

const chunksResult = ({ texts }: { texts: readonly string[] }): TSyncSourceReadResult<TTextChunk> => {
  return { error: undefined, chunks: textChunks({ texts }), end: false };
};

const END: TSyncSourceReadResult<TTextChunk> = { error: undefined, chunks: undefined, end: true };

describe("syncSource", () => {

  it("should be open without the read function being called", () => {
    const { source, calls } = scriptedSyncSource({ results: [] });

    assert.deepEqual(source.status(), { type: "open" });
    assert.equal(calls().length, 0);
  });

  it("should call the read function once per read() and hand out its chunks", () => {
    const { source, calls } = scriptedSyncSource({ results: [chunksResult({ texts: ["a", "b"] }), chunksResult({ texts: ["c"] })] });

    assert.deepEqual(source.read(), { chunks: textChunks({ texts: ["a", "b"] }) });
    assert.deepEqual(source.read(), { chunks: textChunks({ texts: ["c"] }) });
    assert.deepEqual(calls(), [{ hints: { amount: 16384 } }, { hints: { amount: 16384 } }]);
  });

  it("should hand out a new frozen array instead of the one returned by the read function", () => {
    const chunks = textChunks({ texts: ["a"] });
    const result = syncSource<TTextChunk>({
      read: () => {
        return { error: undefined, chunks, end: false };
      }
    }).read();

    assert.notEqual(result.chunks, chunks);
    assert.ok(Object.isFrozen(result.chunks));
  });

  it("should end once the read function signals the end", () => {
    const { source } = scriptedSyncSource({ results: [END] });

    assert.deepEqual(source.read(), { chunks: [] });
    assert.deepEqual(source.status(), { type: "ended" });
  });

  it("should fail once the read function returns an error", () => {
    const { source } = scriptedSyncSource({ results: [{ error: Error("read failed"), chunks: undefined, end: undefined }] });

    assert.deepEqual(source.read(), { chunks: [] });
    assert.deepEqual(source.status(), { type: "failed" });
  });

  it("should trigger a poll right away while open, as there is always something to read", async () => {
    const { source } = scriptedSyncSource({ results: [] });
    let calls = 0;

    source.poll({
      onUpdate: () => {
        calls += 1;
      }
    });
    assert.equal(calls, 0);

    await nextTask();
    assert.equal(calls, 1);
  });

  it("should call the destroy function when destroyed", () => {
    const { source, destroyed } = scriptedSyncSource({ results: [] });

    source.destroy();

    assert.ok(destroyed());
    assert.deepEqual(source.status(), { type: "destroyed" });
  });

  it("should be destroyable without a destroy function", () => {
    const source = sourceGuard({
      source: syncSource<TTextChunk>({
        read: () => {
          return END;
        }
      })
    });

    source.destroy();
    assert.deepEqual(source.status(), { type: "destroyed" });
  });
});
