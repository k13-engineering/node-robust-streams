import assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
  createGuardContext,
  deepFreeze,
  ignore,
  isEqual,
  violation
} from "./guard.ts";

describe("guard", () => {

  describe("isEqual", () => {
    it("should compare primitives by value", () => {
      assert.ok(isEqual({ a: "open", b: "open" }));
      assert.ok(!isEqual({ a: "open", b: "ended" }));
      assert.ok(!isEqual({ a: null, b: {} }));
      assert.ok(!isEqual({ a: { type: "open" }, b: "open" }));
    });

    it("should compare plain objects and arrays deeply", () => {
      assert.ok(isEqual({ a: { type: "failed", details: [1, { code: 2 }] }, b: { type: "failed", details: [1, { code: 2 }] } }));
      assert.ok(!isEqual({ a: { type: "failed", details: [1] }, b: { type: "failed", details: [2] } }));
      assert.ok(!isEqual({ a: { type: "failed" }, b: { type: "failed", details: [] } }));
    });
  });

  describe("deepFreeze", () => {
    it("should return primitives unchanged", () => {
      assert.equal(deepFreeze({ value: 1 }), 1);
      assert.equal(deepFreeze({ value: null }), null);
    });

    it("should freeze objects recursively, but skip array buffer views", () => {
      const data = new Uint8Array(1);
      const value = { nested: { list: [{ data }] } };

      deepFreeze({ value });

      assert.ok(Object.isFrozen(value));
      assert.ok(Object.isFrozen(value.nested.list));
      assert.ok(Object.isFrozen(value.nested.list[0]));
      assert.ok(!Object.isFrozen(data));
    });
  });

  describe("violation", () => {
    it("should create an error marked as contract violation", () => {
      assert.equal(violation({ message: "text" }).message, "contract violation: text");
    });
  });

  describe("createGuardContext", () => {
    it("should leave the call state even if the called function throws", () => {
      const ctx = createGuardContext({
        spec: { name: "test", transitions: [["a", "b"]] },
        status: () => {
          return { type: "a" };
        },
        onObserve: ignore
      });

      assert.throws(() => {
        ctx.call({
          method: "method",
          forbidden: [],
          fn: () => {
            assert.ok(ctx.isInCall());
            throw Error("thrown by the guarded function");
          }
        });
      }, /thrown by the guarded function/);

      assert.ok(!ctx.isInCall());
    });
  });
});
