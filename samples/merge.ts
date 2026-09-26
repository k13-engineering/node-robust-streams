// merge from multiple sources to one sink
//
// a merge source reads from all of its sources, it is pumped into a single file sink,
// run with: node samples/merge.ts

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fixedChunksSource, runPump, sinkGuard, sourceGuard } from "../lib/index.ts";
import { createFileSink } from "./file-sink.ts";
import { createMergeSource } from "./merge-source.ts";

const encoder = new TextEncoder();
const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "robust-streams-sample-"));
const path = nodePath.join(directory, "output.txt");

const sourceOf = ({ texts }: { texts: readonly string[] }) => {
  return sourceGuard({
    source: fixedChunksSource({
      chunks: texts.map((text) => {
        return { data: encoder.encode(text) };
      })
    })
  });
};

const merge = sourceGuard({
  source: createMergeSource({
    sources: [
      sourceOf({ texts: ["from the first source\n"] }),
      sourceOf({ texts: ["from the second source\n", "and some more\n"] })
    ]
  })
});

const sink = sinkGuard({ sink: createFileSink({ path }) });

const result = await runPump({ from: merge, to: sink });

console.log(`result: ${result.type}`);
console.log(fs.readFileSync(path, "utf8"));

fs.rmSync(directory, { recursive: true });
