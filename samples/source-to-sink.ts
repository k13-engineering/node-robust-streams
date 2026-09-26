// simple source --> sink stream
//
// an in-memory source is pumped into a file sink, run with: node samples/source-to-sink.ts

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fixedChunksSource, runPump, sinkGuard, sourceGuard } from "../lib/index.ts";
import { createFileSink } from "./file-sink.ts";

const encoder = new TextEncoder();
const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "robust-streams-sample-"));
const path = nodePath.join(directory, "output.txt");

// the guards are optional, they check the stream contracts at runtime and throw on a violation
const source = sourceGuard({
  source: fixedChunksSource({
    chunks: ["hello\n", "world\n"].map((text) => {
      return { data: encoder.encode(text) };
    })
  })
});

const sink = sinkGuard({ sink: createFileSink({ path }) });

const result = await runPump({ from: source, to: sink });

console.log(`result: ${result.type}`);
console.log(fs.readFileSync(path, "utf8"));

fs.rmSync(directory, { recursive: true });
