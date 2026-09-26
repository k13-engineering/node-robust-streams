import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { fixedChunksSource } from "./fixed-chunks-source.ts";
import { sourceGuard } from "./source-stream.ts";
import { textChunks } from "./test-helpers.spec.ts";

describe("fixedChunksSource", () => {

  it("should hand out all chunks with one read() by default and end with the next one", () => {
    const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b", "c"] }) }) });

    assert.deepEqual(source.read(), { chunks: textChunks({ texts: ["a", "b", "c"] }) });
    assert.deepEqual(source.status(), { type: "open" });

    assert.deepEqual(source.read(), { chunks: [] });
    assert.deepEqual(source.status(), { type: "ended" });
  });

  it("should hand out at most maxPerTurn chunks per read()", () => {
    const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b", "c"] }), maxPerTurn: 2 }) });

    assert.deepEqual(source.read(), { chunks: textChunks({ texts: ["a", "b"] }) });
    assert.deepEqual(source.read(), { chunks: textChunks({ texts: ["c"] }) });
    assert.deepEqual(source.read(), { chunks: [] });
    assert.deepEqual(source.status(), { type: "ended" });
  });

  it("should end with the first read() without chunks", () => {
    const source = sourceGuard({ source: fixedChunksSource({ chunks: [] }) });

    assert.deepEqual(source.read(), { chunks: [] });
    assert.deepEqual(source.status(), { type: "ended" });
  });
});
