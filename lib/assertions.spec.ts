import assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
  assertSinkStatusNotDestroyed,
  assertSinkStatusNotInProgress,
  assertSourceStatusNotDestroyed,
  assertSourceStatusNotInProgress
} from "./assertions.ts";
import { fixedChunksSource } from "./fixed-chunks-source.ts";
import type { TSinkStreamStatus } from "./sink-stream.ts";
import type { TSourceStreamStatus } from "./source-stream.ts";
import { textChunks } from "./test-helpers.spec.ts";

// the full status unions, a declared const would be narrowed by typescript to the assigned status
const sourceStatus = (): TSourceStreamStatus => {
  return { type: "open" };
};

const sinkStatus = (): TSinkStreamStatus => {
  return { type: "open" };
};

describe("assertSourceStatusNotDestroyed", () => {

  it("should throw a contract violation for a destroyed status", () => {
    assert.throws(() => {
      assertSourceStatusNotDestroyed({ type: "destroyed" });
    }, { message: "contract violation: source status MUST NOT be destroyed" });
  });

  it("should accept all other statuses, also with own properties", () => {
    assertSourceStatusNotDestroyed({ type: "open", remainingChunks: 3 });
    assertSourceStatusNotDestroyed({ type: "destroying" });
    assertSourceStatusNotDestroyed({ type: "failed" });
  });

  it("should only take source statuses", () => {
    // @ts-expect-error finishing is a sink status
    assertSourceStatusNotDestroyed({ type: "finishing" });
  });

  it("should let typescript know that the status is not destroyed afterwards", () => {
    const status = fixedChunksSource({ chunks: textChunks({ texts: ["a"] }) }).status();

    assertSourceStatusNotDestroyed(status);

    // @ts-expect-error destroyed has been narrowed away by the assertion
    assert.notEqual(status.type === "destroyed", true);
    assert.equal(status.type, "open");
  });
});

describe("assertSinkStatusNotDestroyed", () => {

  it("should throw a contract violation for a destroyed status", () => {
    assert.throws(() => {
      assertSinkStatusNotDestroyed({ type: "destroyed" });
    }, { message: "contract violation: sink status MUST NOT be destroyed" });
  });

  it("should accept all other statuses, also with own properties", () => {
    assertSinkStatusNotDestroyed({ type: "open", chunksWritten: 3 });
    assertSinkStatusNotDestroyed({ type: "destroying" });
    assertSinkStatusNotDestroyed({ type: "failed" });
  });

  it("should only take sink statuses", () => {
    // @ts-expect-error ending is a source status
    assertSinkStatusNotDestroyed({ type: "ending" });
  });

  it("should let typescript know that the status is not destroyed afterwards", () => {
    const status = sinkStatus();

    assertSinkStatusNotDestroyed(status);

    // @ts-expect-error destroyed has been narrowed away by the assertion
    assert.notEqual(status.type === "destroyed", true);
    assert.equal(status.type, "open");
  });
});

describe("assertSourceStatusNotInProgress", () => {

  (["opening", "ending", "failing", "destroying"] as const).forEach((type) => {
    it(`should throw a contract violation for ${type}`, () => {
      assert.throws(() => {
        assertSourceStatusNotInProgress({ type });
      }, { message: `contract violation: source status MUST NOT be in progress (opening, ending, failing, destroying), but is ${type}` });
    });
  });

  it("should accept all other statuses, also with own properties", () => {
    assertSourceStatusNotInProgress({ type: "open", remainingChunks: 3 });
    assertSourceStatusNotInProgress({ type: "ended" });
    assertSourceStatusNotInProgress({ type: "failed" });
    assertSourceStatusNotInProgress({ type: "destroyed" });
  });

  it("should only take source statuses", () => {
    // @ts-expect-error finishing is a sink status
    assertSourceStatusNotInProgress({ type: "finishing" });
  });

  it("should let typescript know that the status is not in progress afterwards", () => {
    const status = sourceStatus();

    assertSourceStatusNotInProgress(status);

    // @ts-expect-error ending has been narrowed away by the assertion
    assert.notEqual(status.type === "ending", true);
    assert.equal(status.type === "ended", false);
  });
});

describe("assertSinkStatusNotInProgress", () => {

  (["opening", "finishing", "failing", "destroying"] as const).forEach((type) => {
    it(`should throw a contract violation for ${type}`, () => {
      assert.throws(() => {
        assertSinkStatusNotInProgress({ type });
      }, { message: `contract violation: sink status MUST NOT be in progress (opening, finishing, failing, destroying), but is ${type}` });
    });
  });

  it("should accept all other statuses, also with own properties", () => {
    assertSinkStatusNotInProgress({ type: "open", chunksWritten: 3 });
    assertSinkStatusNotInProgress({ type: "finished" });
    assertSinkStatusNotInProgress({ type: "failed" });
    assertSinkStatusNotInProgress({ type: "destroyed" });
  });

  it("should only take sink statuses", () => {
    // @ts-expect-error ending is a source status
    assertSinkStatusNotInProgress({ type: "ending" });
  });

  it("should let typescript know that the status is not in progress afterwards", () => {
    const status = sinkStatus();

    assertSinkStatusNotInProgress(status);

    // @ts-expect-error finishing has been narrowed away by the assertion
    assert.notEqual(status.type === "finishing", true);
    assert.equal(status.type === "finished", false);
  });
});
