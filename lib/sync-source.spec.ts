import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { sourceGuard } from "./source-stream.ts";
import { syncSource } from "./sync-source.ts";
import type { TNoProperties } from "./status-report.ts";
import type {
  TSyncSourceOpenResult,
  TSyncSourceReadArgs,
  TSyncSourceReadResult
} from "./sync-source.ts";
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
        return {};
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

// a sync source reporting properties from open, read and destroy, the read function returns the given results one after another
const reportingSyncSource = ({
  openResult,
  results
}: {
  openResult: TSyncSourceOpenResult<{ lastText: string }>;
  results: readonly TSyncSourceReadResult<TTextChunk, { lastText: string }>[];
}) => {
  let remaining = results;
  let openCalls = 0;
  let readCalls = 0;

  const source = sourceGuard({
    source: syncSource({
      open: () => {
        openCalls += 1;
        return openResult;
      },
      read: () => {
        const [first, ...rest] = remaining;
        remaining = rest;
        readCalls += 1;
        return first;
      },
      destroy: () => {
        return { status: { destroyedBy: "destroy" } };
      }
    })
  });

  return {
    source,
    openCalls: () => {
      return openCalls;
    },
    readCalls: () => {
      return readCalls;
    }
  };
};

const OPENED = { error: undefined, status: { lastText: "" } };

const reportedChunks = ({ texts }: { texts: readonly string[] }) => {
  return { error: undefined, chunks: textChunks({ texts }), end: false as const, status: { lastText: texts[texts.length - 1] } };
};

describe("syncSource status properties", () => {

  it("should call open once right away and add its status properties to the open status", () => {
    const { source, openCalls, readCalls } = reportingSyncSource({ openResult: OPENED, results: [] });

    assert.equal(openCalls(), 1);
    assert.equal(readCalls(), 0);
    assert.deepEqual(source.status(), { type: "open", lastText: "" });
  });

  it("should be failed right away once open returns an error", () => {
    const { source, readCalls } = reportingSyncSource({ openResult: { error: Error("open failed") }, results: [] });

    assert.deepEqual(source.status(), { type: "failed" });
    assert.equal(readCalls(), 0);
  });

  it("should replace the status properties reported by open with the ones reported by every read", () => {
    const { source } = reportingSyncSource({
      openResult: OPENED,
      results: [reportedChunks({ texts: ["a"] }), reportedChunks({ texts: ["b", "c"] })]
    });

    source.read();
    assert.deepEqual(source.status(), { type: "open", lastText: "a" });

    source.read();
    assert.deepEqual(source.status(), { type: "open", lastText: "c" });
  });

  it("should not add the status properties of open once ended", () => {
    const { source } = reportingSyncSource({ openResult: OPENED, results: [reportedChunks({ texts: ["a"] }), END] });

    source.read();
    source.read();

    assert.deepEqual(source.status(), { type: "ended" });
  });

  it("should add the status properties reported by destroy to the destroyed status only", () => {
    const { source } = reportingSyncSource({ openResult: OPENED, results: [] });

    source.destroy();

    assert.deepEqual(source.status(), { type: "destroyed", destroyedBy: "destroy" });
  });

  it("should not add status properties once failed", () => {
    const { source } = reportingSyncSource({
      openResult: OPENED,
      results: [{ error: Error("read failed"), chunks: undefined, end: undefined }]
    });

    source.read();

    assert.deepEqual(source.status(), { type: "failed" });
  });

  it("should yield frozen status objects, a new one once a read reported status properties", () => {
    const { source } = reportingSyncSource({ openResult: OPENED, results: [reportedChunks({ texts: ["a"] })] });
    const before = source.status();

    source.read();

    assert.ok(Object.isFrozen(before));
    assert.ok(Object.isFrozen(source.status()));
    assert.notEqual(source.status(), before);
  });

  it("should trigger a poll right away while open with status properties", async () => {
    const { source } = reportingSyncSource({ openResult: OPENED, results: [] });
    let calls = 0;

    source.poll({
      onUpdate: () => {
        calls += 1;
      }
    });

    await nextTask();
    assert.equal(calls, 1);
  });

  it("should make reported properties accessible to typescript once narrowed, also through a guard", () => {
    const opened = reportingSyncSource({ openResult: OPENED, results: [] }).source;
    const destroyed = reportingSyncSource({ openResult: OPENED, results: [] }).source;

    destroyed.destroy();

    const openStatus = opened.status();
    const destroyedStatus = destroyed.status();

    assert.equal(openStatus.type === "open" ? openStatus.lastText : "-", "");
    assert.equal(destroyedStatus.type === "destroyed" ? destroyedStatus.destroyedBy : "", "destroy");
  });

  it("should infer the status properties from a read function that may also end or fail", () => {
    let texts = ["a", "b"];

    const source = syncSource({
      open: () => {
        return { error: undefined, status: { left: texts.length } };
      },
      read: () => {
        if (texts.length === 0) {
          return { error: undefined, chunks: undefined, end: true };
        }

        if (texts[0] === "") {
          return { error: Error("empty text"), chunks: undefined, end: undefined };
        }

        const [first, ...rest] = texts;
        texts = rest;
        return { error: undefined, chunks: textChunks({ texts: [first] }), end: false, status: { left: texts.length } };
      }
    });

    source.read();
    const status = source.status();
    const left: number = status.type === "open" ? status.left : -1;

    assert.equal(left, 1);
  });
});

// the @ts-expect-error comments make type-check fail, if typescript does not reject these usages anymore
describe("syncSource status property types", () => {

  it("should reject a read reporting status properties without open", () => {
    // @ts-expect-error open is required, as read reports status properties
    const source = syncSource({
      read: () => {
        return reportedChunks({ texts: ["a"] });
      }
    });

    assert.equal(source.status().type, "open");
  });

  it("should reject an open without the status properties read reports", () => {
    const source = syncSource({
      // @ts-expect-error open has to report the status properties read reports
      open: () => {
        return { error: undefined };
      },
      read: () => {
        return reportedChunks({ texts: ["a"] });
      }
    });

    assert.equal(source.status().type, "open");
  });

  it("should reject a read without the status properties open reports", () => {
    const source = syncSource({
      open: () => {
        return OPENED;
      },
      // @ts-expect-error read has to report the status properties open reports together with chunks
      read: () => {
        return { error: undefined, chunks: textChunks({ texts: ["a"] }), end: false };
      }
    });

    assert.equal(source.status().type, "open");
  });

  it("should reject a missing destroy once the status properties of destroyed are non-empty", () => {
    // @ts-expect-error destroy is required, as it reports the status properties of destroyed
    const source = syncSource<TTextChunk, TNoProperties, { destroyedBy: string }>({
      read: () => {
        return END;
      }
    });

    assert.equal(source.status().type, "open");
  });

  it("should reject status properties named like the ones the sync source sets itself", () => {
    // @ts-expect-error type is set by the sync source itself
    const source = syncSource<TTextChunk, { type: string }>({
      open: () => {
        return { error: undefined, status: { type: "mine" } };
      },
      read: () => {
        return END;
      }
    });

    // at runtime, the type set by the sync source wins as well
    assert.equal(source.status().type, "open");
  });
});
