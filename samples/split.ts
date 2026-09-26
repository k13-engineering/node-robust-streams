// split from source to multiple sinks
//
// one source is pumped into a split sink, which writes every chunk to all of its file sinks,
// run with: node samples/split.ts

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fixedChunksSource, runPump, sinkGuard, sourceGuard } from "../lib/index.ts";
import { createFileSink } from "./file-sink.ts";
import { createSplitSink } from "./split-sink.ts";

const encoder = new TextEncoder();
const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "robust-streams-sample-"));
const paths = ["first.txt", "second.txt"].map((name) => {
  return nodePath.join(directory, name);
});

const source = sourceGuard({
  source: fixedChunksSource({
    chunks: ["split\n", "into\n", "two files\n"].map((text) => {
      return { data: encoder.encode(text) };
    })
  })
});

const split = sinkGuard({
  sink: createSplitSink({
    sinks: paths.map((path) => {
      return sinkGuard({ sink: createFileSink({ path }) });
    })
  })
});

const result = await runPump({ from: source, to: split });

console.log(`result: ${result.type}`);
paths.forEach((path) => {
  console.log(`${nodePath.basename(path)}:\n${fs.readFileSync(path, "utf8")}`);
});

fs.rmSync(directory, { recursive: true });
