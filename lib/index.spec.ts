import assert from "node:assert/strict";
import { describe, it } from "mocha";
import * as robustStreams from "./index.ts";

describe("index", () => {
  it("should export the public api", () => {
    assert.deepEqual(Object.keys(robustStreams).toSorted(), [
      "assertPumpable",
      "assertSinkStatusNotDestroyed",
      "assertSinkStatusNotInProgress",
      "assertSourceStatusNotDestroyed",
      "assertSourceStatusNotInProgress",
      "createBinaryStreamPressureGauge",
      "createBinaryStreamPressureGaugePump",
      "createPollRegistry",
      "createStreamPressureGauge",
      "duplexGuard",
      "errorSource",
      "fixedChunksSource",
      "nullSink",
      "pump",
      "runPump",
      "sinkGuard",
      "sourceGuard",
      "syncDuplex",
      "syncSink",
      "syncSource"
    ]);
  });

  it("should load the type-only modules, which requires them to only contain erasable syntax", async () => {
    const modules = await Promise.all([import("./poll.ts"), import("./stream-chunk.ts")]);

    assert.deepEqual(modules.map((loaded) => {
      return Object.keys(loaded);
    }), [[], []]);
  });
});
