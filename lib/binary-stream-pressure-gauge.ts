import { violation } from "./guard.ts";
import type { TSinkStreamWriteTransaction } from "./sink-stream.ts";
import type { TBinaryStreamChunk } from "./stream-chunk.ts";

// above a watermark means more pending bytes than the watermark
type TBinaryStreamPressureGaugeStatus = {
  // at most lowWatermark bytes are pending
  type: "below-low-watermark";
  pendingBytes: number;
} | {
  // more than lowWatermark, but at most highWatermark bytes are pending
  type: "above-low-watermark";
  pendingBytes: number;
} | {
  // more than highWatermark bytes are pending
  type: "above-high-watermark";
  pendingBytes: number;
};

type TBinaryStreamPressureGauge = {
  // adds a transaction and the chunks written with it to the ones the gauge keeps track of
  report: (args: { transaction: TSinkStreamWriteTransaction; chunks: readonly TBinaryStreamChunk[] }) => void;

  // like report(), but takes the result of pump() as it is, a result without transaction is ignored
  reportPumpResult: (args: {
    pumpResult: { transaction: TSinkStreamWriteTransaction | undefined; chunks: readonly TBinaryStreamChunk[] }
  }) => void;

  // measures the bytes of the reported transactions that are still pending, the others are removed from the gauge
  status: () => TBinaryStreamPressureGaugeStatus;

  // whether more chunks should be written, i.e. whether pump() should be called:
  //  - false once more bytes than the high watermark were pending, until at most the low watermark are pending again
  //  - true otherwise
  takesMore: () => boolean;
};

type TTrackedTransaction = {
  transaction: TSinkStreamWriteTransaction;
  bytes: number;
};

const byteLengthOf = ({ chunks }: { chunks: readonly TBinaryStreamChunk[] }) => {
  return chunks.reduce((sum, chunk) => {
    return sum + chunk.data.byteLength;
  }, 0);
};

const zoneOf = ({
  pendingBytes,
  lowWatermark,
  highWatermark
}: {
  pendingBytes: number;
  lowWatermark: number;
  highWatermark: number;
}): TBinaryStreamPressureGaugeStatus["type"] => {
  if (pendingBytes > highWatermark) {
    return "above-high-watermark";
  }

  if (pendingBytes > lowWatermark) {
    return "above-low-watermark";
  }

  return "below-low-watermark";
};

// the gauge becomes full above the high watermark and stays full until it is below the low watermark again
const fullAfter = ({ type, full }: { type: TBinaryStreamPressureGaugeStatus["type"]; full: boolean }) => {
  if (type === "above-high-watermark") {
    return true;
  }

  return full && type === "above-low-watermark";
};

// keeps track of the bytes of the pending transactions of a binary stream, e.g. to stop writing once above
// the high watermark and to continue writing once below the low watermark again
const createBinaryStreamPressureGauge = ({
  lowWatermark,
  highWatermark
}: {
  lowWatermark: number;
  highWatermark: number;
}): TBinaryStreamPressureGauge => {
  if (lowWatermark > highWatermark) {
    throw violation({ message: `the low watermark (${lowWatermark}) MUST NOT be above the high watermark (${highWatermark})` });
  }

  let tracked: readonly TTrackedTransaction[] = [];
  let full = false;

  // every measurement updates whether the gauge is full, pending bytes only grow with a report,
  // so measuring after each report catches every time the high watermark is exceeded
  const status = (): TBinaryStreamPressureGaugeStatus => {
    tracked = tracked.filter(({ transaction }) => {
      return transaction.status().type === "pending";
    });

    const pendingBytes = tracked.reduce((sum, { bytes }) => {
      return sum + bytes;
    }, 0);
    const type = zoneOf({ pendingBytes, lowWatermark, highWatermark });

    full = fullAfter({ type, full });

    return Object.freeze({ type, pendingBytes });
  };

  const report: TBinaryStreamPressureGauge["report"] = ({ transaction, chunks }) => {
    tracked = [...tracked, { transaction, bytes: byteLengthOf({ chunks }) }];
    status();
  };

  const reportPumpResult: TBinaryStreamPressureGauge["reportPumpResult"] = ({ pumpResult: { transaction, chunks } }) => {
    if (transaction !== undefined) {
      report({ transaction, chunks });
    }
  };

  const takesMore = () => {
    status();
    return !full;
  };

  return {
    report,
    reportPumpResult,
    status,
    takesMore
  };
};

export type {
  TBinaryStreamPressureGauge,
  TBinaryStreamPressureGaugeStatus
};

export {
  createBinaryStreamPressureGauge
};
