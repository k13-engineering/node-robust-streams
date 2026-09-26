import { fixedChunksSource } from "../lib/fixed-chunks-source.ts";
import { createPump } from "../lib/pump.ts";
import { syncSink } from "../lib/sync-sink.ts";


const source = fixedChunksSource({
  chunks: [
    {
      data: "chunk1"
    },
    {
      data: "chunk2"
    },
    {
      data: "chunk3"
    }
  ],
  maxPerTurn: 1
});


const sink = syncSink({
  write: ({ chunks }) => {
    console.log("Writing chunks:", chunks);

    return {
      error: undefined
    };
  },

  finish: () => {
    console.log("Finished writing chunks");

    return {
      error: undefined
    };
  },

  destroy: () => {
    console.log("Sink destroyed");
  }
});

const pump = createPump({
  from: source,
  to: sink,
});

// eslint-disable-next-line complexity
const next = () => {

  const sourceStatus = source.status();
  console.log({ sourceStatus });


  if (sourceStatus.type === "failed") {
    console.error("Source has failed or is failing:", sourceStatus);
    return;
  }

  const sinkStatus = sink.status();
  if (sinkStatus.type === "failed") {
    console.error("Sink has failed or is failing:", sinkStatus);
    return;
  }

  const pending = pump.pending();
  if (pending.length === 0) {
    const { done } = pump.pump();
    if (done) {
      console.log("Pump completed successfully");
      return;
    }
  }

  setTimeout(() => {
    next();
  }, 10);
};

next();
