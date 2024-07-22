import { create as createNodeTestRunner } from "ya-test-library/node-test-runner";
import { sourceTestGroup } from "./source/index.ts";
import { sinkTestGroup } from "./sink/index.ts";

const runner = createNodeTestRunner();
runner.run({
  group: {
    groups: {
      source: sourceTestGroup,
      sink: sinkTestGroup
    }
  },
});
