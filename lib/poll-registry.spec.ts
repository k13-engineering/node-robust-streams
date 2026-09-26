import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createPollRegistry } from "./poll-registry.ts";
import { moduleUrl, nextTask, runModule } from "./test-helpers.spec.ts";

const createCounter = () => {
  let calls = 0;

  return {
    onUpdate: () => {
      calls += 1;
    },
    calls: () => {
      return calls;
    }
  };
};

describe("createPollRegistry", () => {

  describe("triggering", () => {
    it("should never trigger a poll synchronously", async () => {
      const registry = createPollRegistry();
      const counter = createCounter();

      const handle = registry.poll({ onUpdate: counter.onUpdate, ready: true });
      assert.equal(counter.calls(), 0);
      assert.equal(handle.status().type, "pending");

      await nextTask();
      assert.equal(counter.calls(), 1);
      assert.equal(handle.status().type, "triggered");
    });

    it("should already yield triggered when onUpdate is called", async () => {
      const registry = createPollRegistry();
      let observed = "";

      const handle = registry.poll({
        onUpdate: () => {
          observed = handle.status().type;
        },
        ready: true
      });

      await nextTask();
      assert.equal(observed, "triggered");
    });

    it("should only trigger a waiting poll after notify, but not within notify", async () => {
      const registry = createPollRegistry();
      const counter = createCounter();

      registry.poll({ onUpdate: counter.onUpdate, ready: false });
      await nextTask();
      assert.equal(counter.calls(), 0);

      registry.notify();
      assert.equal(counter.calls(), 0);

      await nextTask();
      assert.equal(counter.calls(), 1);
    });

    it("should trigger each of multiple pending polls exactly once", async () => {
      const registry = createPollRegistry();
      const first = createCounter();
      const second = createCounter();

      registry.poll({ onUpdate: first.onUpdate, ready: false });
      registry.poll({ onUpdate: second.onUpdate, ready: false });
      registry.notify();
      registry.notify();

      await nextTask();
      assert.deepEqual([first.calls(), second.calls()], [1, 1]);
    });

    it("should not trigger polls registered after notify", async () => {
      const registry = createPollRegistry();
      const counter = createCounter();

      registry.notify();
      registry.poll({ onUpdate: counter.onUpdate, ready: false });

      await nextTask();
      assert.equal(counter.calls(), 0);
    });
  });

  describe("cancel", () => {
    it("should not trigger a poll cancelled while waiting", async () => {
      const registry = createPollRegistry();
      const counter = createCounter();

      const handle = registry.poll({ onUpdate: counter.onUpdate, ready: false });
      handle.cancel();
      registry.notify();

      await nextTask();
      assert.equal(counter.calls(), 0);
      assert.equal(handle.status().type, "cancelled");
    });

    it("should not trigger a poll cancelled after it was scheduled", async () => {
      const registry = createPollRegistry();
      const counter = createCounter();

      const handle = registry.poll({ onUpdate: counter.onUpdate, ready: true });
      handle.cancel();

      await nextTask();
      assert.equal(counter.calls(), 0);
      assert.equal(handle.status().type, "cancelled");
    });

    it("should keep other polls when one is cancelled", async () => {
      const registry = createPollRegistry();
      const kept = createCounter();

      registry.poll({ onUpdate: kept.onUpdate, ready: false });
      registry.poll({ onUpdate: createCounter().onUpdate, ready: false }).cancel();
      registry.notify();

      await nextTask();
      assert.equal(kept.calls(), 1);
    });
  });

  describe("reentrancy", () => {
    it("should allow polling from within onUpdate", async () => {
      const registry = createPollRegistry();
      const inner = createCounter();

      registry.poll({
        onUpdate: () => {
          registry.poll({ onUpdate: inner.onUpdate, ready: false });
          registry.notify();
        },
        ready: true
      });

      await nextTask();
      assert.equal(inner.calls(), 0);

      await nextTask();
      assert.equal(inner.calls(), 1);
    });
  });

  describe("exceptions", () => {
    it("should not catch exceptions thrown from onUpdate, they crash the process", () => {
      const result = runModule({
        source: [
          `import { createPollRegistry } from ${JSON.stringify(moduleUrl({ file: "./poll-registry.ts" }))};`,
          `createPollRegistry().poll({ onUpdate: () => { throw Error("thrown from onUpdate"); }, ready: true });`
        ].join("\n")
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /thrown from onUpdate/);
    });
  });
});
