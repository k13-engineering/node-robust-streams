import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { sinkGuard } from "./sink-stream.ts";
import { syncSink } from "./sync-sink.ts";
import type { TSyncSinkFinishResult, TSyncSinkWriteResult } from "./sync-sink.ts";
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

    assert.deepEqual(sink.status(), { type: "open" });
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
    assert.deepEqual(sink.status(), { type: "finished" });
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
    assert.deepEqual(sink.status(), { type: "destroyed" });
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
