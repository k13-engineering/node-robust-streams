// simple source --> transform --> sink stream
//
// lines are upper cased and encoded by a transform and written to a file,
// one pump moves the lines into the transform, another one moves its output into the file,
// run with: node samples/source-transform-sink.ts

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  fixedChunksSource,
  runPump,
  sinkGuard,
  sourceGuard,
  syncTransform,
  transformGuard
} from "../lib/index.ts";
import type { TBinaryStreamChunk } from "../lib/index.ts";
import { createFileSink } from "./file-sink.ts";

type TLine = {
  line: string;
};

const encoder = new TextEncoder();
const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "robust-streams-sample-"));
const path = nodePath.join(directory, "output.txt");

const source = sourceGuard({
  source: fixedChunksSource<TLine>({
    chunks: [{ line: "first" }, { line: "second" }, { line: "third" }]
  })
});

const transform = transformGuard({
  transform: syncTransform<TLine, TBinaryStreamChunk>({
    transform: ({ chunks }) => {
      return {
        chunks: chunks.map((chunk) => {
          return { data: encoder.encode(`${chunk.line.toUpperCase()}\n`) };
        })
      };
    }
  })
});

const sink = sinkGuard({ sink: createFileSink({ path }) });

const results = await Promise.all([
  runPump({ from: source, to: transform }),
  runPump({ from: transform, to: sink })
]);

console.log(`results: ${results.map((result) => {
  return result.type;
}).join(", ")}`);
console.log(fs.readFileSync(path, "utf8"));

fs.rmSync(directory, { recursive: true });
