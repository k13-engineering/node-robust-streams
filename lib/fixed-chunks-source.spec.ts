import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { fixedChunksSource } from "./fixed-chunks-source.ts";
import { sourceGuard } from "./source-stream.ts";
import { textChunks } from "./test-helpers.spec.ts";

describe("fixedChunksSource", () => {

  describe("reading", () => {
    it("should hand out all chunks with one read() by default and end with the next one", () => {
      const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b", "c"] }) }) });

      assert.deepEqual(source.read(), { chunks: textChunks({ texts: ["a", "b", "c"] }) });
      assert.equal(source.status().type, "open");

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

  describe("status", () => {
    it("should report the number of remaining chunks while open", () => {
      const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a", "b", "c"] }), maxPerTurn: 2 }) });

      assert.deepEqual(source.status(), { type: "open", remainingChunks: 3 });
      source.read();
      assert.deepEqual(source.status(), { type: "open", remainingChunks: 1 });
      source.read();
      assert.deepEqual(source.status(), { type: "open", remainingChunks: 0 });
    });

    it("should make remainingChunks accessible to typescript once narrowed to open, also through a guard", () => {
      const status = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a"] }) }) }).status();
      const remaining = status.type === "open" ? status.remainingChunks : -1;

      assert.equal(remaining, 1);
    });

    it("should yield frozen status objects, a new one once the remaining chunks changed", () => {
      const source = fixedChunksSource({ chunks: textChunks({ texts: ["a"] }) });
      const before = source.status();

      source.read();

      assert.ok(Object.isFrozen(before));
      assert.deepEqual(before, { type: "open", remainingChunks: 1 });
      assert.deepEqual(source.status(), { type: "open", remainingChunks: 0 });
    });

    it("should not report remaining chunks once not open anymore", () => {
      const source = sourceGuard({ source: fixedChunksSource({ chunks: textChunks({ texts: ["a"] }) }) });

      source.destroy();

      assert.deepEqual(source.status(), { type: "destroyed" });
    });
  });
});
