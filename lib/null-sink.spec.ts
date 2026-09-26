import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { nullSink } from "./null-sink.ts";
import { sinkGuard } from "./sink-stream.ts";
import { textChunks } from "./test-helpers.spec.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

describe("nullSink", () => {

  it("should accept all chunks and finish", () => {
    const sink = sinkGuard({ sink: nullSink<TTextChunk>() });

    const transaction = sink.write({ chunks: textChunks({ texts: ["a"] }) });
    sink.end();

    assert.deepEqual(transaction.status(), { type: "committed" });
    assert.deepEqual(sink.status(), { type: "finished" });
  });

  it("should be destroyable", () => {
    const sink = sinkGuard({ sink: nullSink<TTextChunk>() });

    sink.destroy();

    assert.deepEqual(sink.status(), { type: "destroyed" });
  });
});
