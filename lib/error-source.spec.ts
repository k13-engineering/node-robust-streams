import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { errorSource } from "./error-source.ts";
import { sourceGuard } from "./source-stream.ts";
import type { TTextChunk } from "./test-helpers.spec.ts";

describe("errorSource", () => {

  it("should be failed right away", () => {
    assert.deepEqual(sourceGuard({ source: errorSource<TTextChunk>() }).status(), { type: "failed" });
  });

  it("should throw a contract violation when a method is called that MUST NOT be called in status failed", () => {
    const source = errorSource<TTextChunk>();

    assert.throws(() => {
      source.read();
    }, /contract violation: errorSource\.read\(\) MUST NOT be called in status failed/);

    assert.throws(() => {
      source.poll({ onUpdate: () => {} });
    }, /contract violation: errorSource\.poll\(\) MUST NOT be called in status failed/);

    assert.throws(() => {
      source.destroy();
    }, /contract violation: errorSource\.destroy\(\) MUST NOT be called in status failed/);
  });
});
