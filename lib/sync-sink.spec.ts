import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { sinkGuard } from "./sink-stream.ts";
import { syncSink } from "./sync-sink.ts";
import type {
  TSyncSinkFinishResult,
  TSyncSinkOpenResult,
  TSyncSinkWriteResult
} from "./sync-sink.ts";
import { nextTask, textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

const OK = { error: undefined };

// a sync sink recording its calls, write and finish return the given results
const recordingSyncSink = ({
  writeResult = OK,
  finishResult = OK
}: {
  writeResult?: TSyncSinkWriteResult;
  finishResult?: TSyncSinkFinishResult;
}) => {
  let calls: readonly string[] = [];

  const record = ({ call }: { call: string }) => {
    calls = [...calls, call];
  };

  const sink = sinkGuard({
    sink: syncSink<TTextChunk>({
      write: ({ chunks }) => {
        const joined = chunks.map((chunk) => {
          return chunk.text;
        }).join("");

        record({ call: `write ${joined}` });
        return writeResult;
      },
      finish: () => {
        record({ call: "finish" });
        return finishResult;
      },
      destroy: () => {
        record({ call: "destroy" });
        return {};
      }
    })
  });

  return {
    sink,
    calls: () => {
      return calls;
    }
  };
};

describe("syncSink", () => {

  it("should be open and hand written chunks to the write function right away", () => {
    const { sink, calls } = recordingSyncSink({});

    assert.deepEqual(sink.status(), { type: "open", chunksWritten: 0 });
    sink.write({ chunks: textChunks({ texts: ["a", "b"] }) });

    assert.deepEqual(calls(), ["write ab"]);
  });

  it("should commit transactions right away, in order", () => {
    const { sink } = recordingSyncSink({});

    const first = sink.write({ chunks: textChunks({ texts: ["a"] }) });
    const second = sink.write({ chunks: textChunks({ texts: ["b"] }) });

    assert.deepEqual([first.status(), second.status()], [{ type: "committed" }, { type: "committed" }]);
  });

  it("should fail and discard the transaction once the write function returns an error", () => {
    const { sink } = recordingSyncSink({ writeResult: { error: Error("write failed") } });

    const transaction = sink.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(sink.status(), { type: "failed" });
    assert.deepEqual(transaction.status(), { type: "discarded" });
  });

  it("should call the finish function on end() and be finished afterwards", () => {
    const { sink, calls } = recordingSyncSink({});

    sink.write({ chunks: textChunks({ texts: ["a"] }) });
    sink.end();

    assert.deepEqual(calls(), ["write a", "finish"]);
    assert.deepEqual(sink.status(), { type: "finished", chunksWritten: 1 });
  });

  it("should fail once the finish function returns an error", () => {
    const { sink } = recordingSyncSink({ finishResult: { error: Error("finish failed") } });

    sink.end();

    assert.deepEqual(sink.status(), { type: "failed" });
  });

  it("should call the destroy function when destroyed", () => {
    const { sink, calls } = recordingSyncSink({});

    sink.destroy();

    assert.deepEqual(calls(), ["destroy"]);
    assert.deepEqual(sink.status(), { type: "destroyed", chunksWritten: 0 });
  });

  it("should trigger a poll asynchronously once its status changed", async () => {
    const { sink } = recordingSyncSink({});
    let calls = 0;

    sink.poll({
      onUpdate: () => {
        calls += 1;
      }
    });
    sink.end();
    assert.equal(calls, 0);

    await nextTask();
    assert.equal(calls, 1);
  });
});

// a sync sink reporting status properties from open and every write, and transaction properties from every write
const reportingSyncSink = () => {
  let position = 0;

  return sinkGuard({
    sink: syncSink({
      open: () => {
        return { error: undefined, status: { lastText: "" } };
      },
      write: ({ chunks }: { chunks: readonly TTextChunk[] }) => {
        position += 1;
        return { error: undefined, status: { lastText: chunks[chunks.length - 1].text }, transaction: { position } };
      },
      finish: () => {
        return { error: undefined };
      },
      destroy: () => {
        return {};
      }
    })
  });
};

describe("syncSink status properties", () => {

  it("should count the chunks written while open, finished and destroyed", () => {
    const finished = recordingSyncSink({});
    const destroyed = recordingSyncSink({});

    finished.sink.write({ chunks: textChunks({ texts: ["a", "b"] }) });
    finished.sink.write({ chunks: textChunks({ texts: ["c"] }) });
    assert.deepEqual(finished.sink.status(), { type: "open", chunksWritten: 3 });
    finished.sink.end();
    assert.deepEqual(finished.sink.status(), { type: "finished", chunksWritten: 3 });

    destroyed.sink.write({ chunks: textChunks({ texts: ["a"] }) });
    destroyed.sink.destroy();
    assert.deepEqual(destroyed.sink.status(), { type: "destroyed", chunksWritten: 1 });
  });

  it("should not count the chunks of a failed write, and report no count once failed", () => {
    const { sink } = recordingSyncSink({ writeResult: { error: Error("write failed") } });

    sink.write({ chunks: textChunks({ texts: ["a"] }) });

    assert.deepEqual(sink.status(), { type: "failed" });
  });

  it("should replace the status properties reported by open with the ones reported by every write", () => {
    const sink = reportingSyncSink();

    assert.deepEqual(sink.status(), { type: "open", chunksWritten: 0, lastText: "" });

    sink.write({ chunks: textChunks({ texts: ["a"] }) });
    assert.deepEqual(sink.status(), { type: "open", chunksWritten: 1, lastText: "a" });

    sink.write({ chunks: textChunks({ texts: ["b", "c"] }) });
    assert.deepEqual(sink.status(), { type: "open", chunksWritten: 3, lastText: "c" });
  });

  it("should not add the status properties of open once not open anymore", () => {
    const sink = reportingSyncSink();

    sink.write({ chunks: textChunks({ texts: ["a"] }) });
    sink.end();

    assert.deepEqual(sink.status(), { type: "finished", chunksWritten: 1 });
  });

  it("should add the transaction properties reported by write to the committed transaction status", () => {
    const sink = reportingSyncSink();

    const first = sink.write({ chunks: textChunks({ texts: ["a"] }) });
    const second = sink.write({ chunks: textChunks({ texts: ["b"] }) });

    assert.deepEqual(first.status(), { type: "committed", position: 1 });
    assert.deepEqual(second.status(), { type: "committed", position: 2 });
  });

  it("should make reported properties accessible to typescript once narrowed, also through a guard", () => {
    const sink = reportingSyncSink();

    const transactionStatus = sink.write({ chunks: textChunks({ texts: ["a"] }) }).status();
    const status = sink.status();

    const position: number = transactionStatus.type === "committed" ? transactionStatus.position : -1;
    const lastText: string = status.type === "open" ? status.lastText : "";

    assert.deepEqual([position, lastText], [1, "a"]);
  });
});

const finishAndDestroy = {
  finish: () => {
    return { error: undefined };
  },
  destroy: () => {
    return {};
  }
};

// the @ts-expect-error comments make type-check fail, if typescript does not reject these usages anymore
describe("syncSink status property types", () => {

  it("should reject a write reporting status properties without open", () => {
    // @ts-expect-error open is required, as write reports status properties
    const sink = syncSink({
      write: () => {
        return { error: undefined, status: { lastText: "a" } };
      },
      ...finishAndDestroy
    });

    assert.equal(sink.status().type, "open");
  });

  it("should reject an open without the status properties write reports", () => {
    const sink = syncSink({
      // @ts-expect-error open has to report the status properties write reports
      open: () => {
        return { error: undefined };
      },
      write: () => {
        return { error: undefined, status: { lastText: "a" } };
      },
      ...finishAndDestroy
    });

    assert.equal(sink.status().type, "open");
  });

  it("should reject a write without the status properties open reports", () => {
    const sink = syncSink({
      open: () => {
        return { error: undefined, status: { lastText: "" } };
      },
      // @ts-expect-error write has to report the status properties open reports
      write: () => {
        return { error: undefined };
      },
      ...finishAndDestroy
    });

    assert.equal(sink.status().type, "open");
  });

  it("should infer the status and transaction properties from a write function that may also fail", () => {
    const sink = syncSink({
      open: () => {
        return { error: undefined, status: { lastText: "" } };
      },
      write: ({ chunks }: { chunks: readonly TTextChunk[] }) => {
        if (chunks.length === 0) {
          return { error: Error("nothing to write") };
        }

        return { error: undefined, status: { lastText: chunks[0].text }, transaction: { first: chunks[0].text } };
      },
      ...finishAndDestroy
    });

    const transactionStatus = sink.write({ chunks: textChunks({ texts: ["a"] }) }).status();
    const status = sink.status();
    const first: string = transactionStatus.type === "committed" ? transactionStatus.first : "";
    const lastText: string = status.type === "open" ? status.lastText : "";

    assert.deepEqual([first, lastText], ["a", "a"]);
  });

  it("should allow status properties that may be undefined, if they are declared that way", () => {
    const sink = syncSink<TTextChunk, { lastText?: string }>({
      open: () => {
        return { error: undefined, status: {} };
      },
      write: () => {
        return { error: undefined, status: { lastText: "a" } };
      },
      ...finishAndDestroy
    });

    const status = sink.status();
    const lastText: string | undefined = status.type === "open" ? status.lastText : "";

    assert.equal(lastText, undefined);
  });
});

// a sync sink reporting properties from open, finish and destroy
const lifecycleSyncSink = ({ openResult }: { openResult: TSyncSinkOpenResult<{ lastText: string }> }) => {
  let openCalls = 0;

  const sink = sinkGuard({
    sink: syncSink({
      open: () => {
        openCalls += 1;
        return openResult;
      },
      write: ({ chunks }: { chunks: readonly TTextChunk[] }) => {
        return { error: undefined, status: { lastText: chunks[chunks.length - 1].text } };
      },
      finish: () => {
        return { error: undefined, status: { finishedBy: "finish" } };
      },
      destroy: () => {
        return { status: { destroyedBy: "destroy" } };
      }
    })
  });

  return {
    sink,
    openCalls: () => {
      return openCalls;
    }
  };
};

describe("syncSink open, finish and destroy", () => {

  it("should call open once right away and add its status properties to the open status", () => {
    const { sink, openCalls } = lifecycleSyncSink({ openResult: { error: undefined, status: { lastText: "" } } });

    assert.equal(openCalls(), 1);
    assert.deepEqual(sink.status(), { type: "open", chunksWritten: 0, lastText: "" });

    sink.write({ chunks: textChunks({ texts: ["a"] }) });
    assert.deepEqual(sink.status(), { type: "open", chunksWritten: 1, lastText: "a" });
  });

  it("should be failed right away once open returns an error", () => {
    const { sink } = lifecycleSyncSink({ openResult: { error: Error("open failed") } });

    assert.deepEqual(sink.status(), { type: "failed" });
  });

  it("should add the status properties reported by finish to the finished status", () => {
    const { sink } = lifecycleSyncSink({ openResult: { error: undefined, status: { lastText: "" } } });

    sink.write({ chunks: textChunks({ texts: ["a"] }) });
    sink.end();

    assert.deepEqual(sink.status(), { type: "finished", chunksWritten: 1, finishedBy: "finish" });
  });

  it("should add the status properties reported by destroy to the destroyed status", () => {
    const { sink } = lifecycleSyncSink({ openResult: { error: undefined, status: { lastText: "" } } });

    sink.destroy();

    assert.deepEqual(sink.status(), { type: "destroyed", chunksWritten: 0, destroyedBy: "destroy" });
  });

  it("should make the properties of finished and destroyed accessible to typescript once narrowed", () => {
    const finished = lifecycleSyncSink({ openResult: { error: undefined, status: { lastText: "" } } }).sink;
    const destroyed = lifecycleSyncSink({ openResult: { error: undefined, status: { lastText: "" } } }).sink;

    finished.end();
    destroyed.destroy();

    const finishedStatus = finished.status();
    const destroyedStatus = destroyed.status();

    assert.equal(finishedStatus.type === "finished" ? finishedStatus.finishedBy : "", "finish");
    assert.equal(destroyedStatus.type === "destroyed" ? destroyedStatus.destroyedBy : "", "destroy");
  });
});
