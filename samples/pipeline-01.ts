import { syncTransform } from "../lib/sync-transform.ts";
import { createPipelineNetwork, pipeline } from "../lib/pipeline.ts";
import { syncSink } from "../lib/sync-sink.ts";
import { fixedChunksSource } from "../lib/fixed-chunks-source.ts";

const transform = syncTransform<string, string>({
  transform: ({ chunks }) => {
    return {
      error: undefined,
      chunks
    };

    // return {
    //   error: Error("stream error in first transform"),
    // };
  }
});

const transform2 = syncTransform<string, number>({
  transform: ({ chunks }) => {

    chunks;

    return {
      error: undefined,
      chunks: [1]
    };
  }
});

const sink = syncSink<number>({
  write: ({ chunks }) => {
    chunks.forEach((chunk) => {
      console.log(`sink got chunk: ${chunk}`);
    });

    return { error: undefined };
    // return { error: Error("stream error in sink") };
  },

  finish: () => {
    return { error: undefined };
  },

  destroy: () => {

  }
});

const pn = createPipelineNetwork();
pn.rewire({
  network: [
    pipeline({
      from: fixedChunksSource({
        chunks: [ "123" ]
      }),

      to: transform
    }),

    pipeline({
      from: transform,
      to: transform2
    }),

    pipeline({
      from: transform2,
      to: sink
    })
  ]
});


pn.stream({
  done: () => {
    console.log("pipeline network done");
  },

  failed: ({ error }) => {
    console.error("pipeline network failed", error);
  }
});
