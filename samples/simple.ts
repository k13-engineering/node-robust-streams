import { assertSinkStatusNotDestroyed, assertSourceStatusNotDestroyed } from "../lib/assertions.ts";
import { createBinaryStreamPressureGaugePump } from "../lib/binary-stream-pressure-gauge-pump.ts";
import { fixedChunksSource } from "../lib/fixed-chunks-source.ts";
import { assertPumpable } from "../lib/pump.ts";
import type { TBinaryStreamChunk } from "../lib/stream-chunk.ts";
import { syncSink } from "../lib/sync-sink.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const source = fixedChunksSource({
  chunks: ["chunk1", "chunk2", "chunk3"].map((text) => {
    return { data: encoder.encode(text) };
  }),
  maxPerTurn: 1
});


const sink = syncSink({
  // called right away, an error would fail the sink
  open: () => {
    console.log("Opening sink");

    return {
      error: undefined,
    };
  },

  write: ({ chunks }: { chunks: readonly TBinaryStreamChunk[] }) => {
    console.log("Writing chunks:", chunks.map((chunk) => {
      return decoder.decode(chunk.data);
    }));

    return {
      error: undefined,

      // added to the status of the transaction once committed
      transaction: {
        myProp: 4
      }
    };
  },

  finish: () => {
    console.log("Finished writing chunks");

    return {
      error: undefined,
    };
  },

  destroy: () => {
    console.log("Sink destroyed");

    return {
      // added to the status of the sink once destroyed
    };
  }
});

console.log("Sink status after opening:", sink.status());

// pumps as long as at most 16 bytes are not committed by the sink yet, once more are, it waits for the sink
// until at most 8 bytes are not committed anymore, as a sync sink commits right away, it never waits here
const gaugePump = createBinaryStreamPressureGaugePump({ lowWatermark: 8, highWatermark: 16 });

// eslint-disable-next-line complexity, max-statements
const next = () => {

  const sourceStatus = source.status();
  const sinkStatus = sink.status();

  console.log({ sourceStatus });

  assertSourceStatusNotDestroyed(sourceStatus);
  assertSinkStatusNotDestroyed(sinkStatus);

  if (sourceStatus.type === "failed") {
    console.error("Source has failed or was destroyed:", sourceStatus);

    if (sinkStatus.type === "open") {
      sink.destroy();
    }

    return;
  }

  if (sinkStatus.type === "failed") {

    if (sourceStatus.type !== "ended") {
      source.destroy();
    }

    console.error("Sink has failed or was destroyed:", sinkStatus);
    return;
  }

  // pump() ended the sink once the source had nothing more to provide
  if (sinkStatus.type === "finished") {
    console.log("Pump completed successfully, sink status:", sinkStatus);
    return;
  }

  // assertPumpable() only accepts an opening or open source, once the source ended, the sink is ended right away
  if (sourceStatus.type === "ended") {
    if (sinkStatus.type === "open") {
      sink.poll({ onUpdate: next });
      sink.end();
    }

    console.log("Source ended, sink status:", sink.status());
    return;
  }

  assertPumpable({ fromStatus: sourceStatus, toStatus: sinkStatus });

  const pumpResult = gaugePump.maybePump({ from: source, to: sink });

  // issues the poll the next call waits for, on either source or sink, next is called once it should be called,
  // once the sink has been ended, it is called right away, so next notices that the sink finished
  pumpResult.poll({ onUpdate: next });
};

next();
