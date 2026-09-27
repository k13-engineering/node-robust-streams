import { createBinaryStreamPressureGauge } from "./binary-stream-pressure-gauge.ts";
import { createPollRegistry } from "./poll-registry.ts";
import {
  checkPumpable,
  isExhausted,
  isPumpable,
  pump
} from "./pump.ts";
import type { TPumpPoll, TPumpSink, TPumpSource } from "./pump.ts";
import type {
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";
import type { TBinaryStreamChunk } from "./stream-chunk.ts";

type TBinaryStreamPressureGaugePumpResult<X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus> = {
  // the transaction returned by to, if chunks have been written to it
  transaction: TSinkStreamWriteTransaction<X> | undefined;

  // issues the poll the next call waits for
  poll: TPumpPoll;
};

type TBinaryStreamPressureGaugePump = {
  // MUST NOT be called in the statuses of from and to pump() MUST NOT be called in
  // pumps like pump(), as long as the gauge takes more, i.e. until more than highWatermark bytes are pending,
  // afterwards it does not pump until at most lowWatermark bytes are pending again:
  //  - while not pumping, the transaction is undefined and the poll waits for to, as only to committing makes
  //    the gauge take more again, what to wait for is decided when poll() is called, like with pump()
  //  - once from will not provide chunks anymore, it pumps regardless of the gauge, as this only ends to,
  //    so a sink committing only once ended does not keep the gauge from taking more forever
  maybePump: <
    T extends TBinaryStreamChunk,
    X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus
  >(args: { from: TPumpSource<T>; to: TPumpSink<T, X> }) => TBinaryStreamPressureGaugePumpResult<X>;
};

// what to wait for while not pumping, a broken stream or a gauge taking more again is noticed by the caller right away
const pollWhileFull = <T extends TBinaryStreamChunk, X extends TSinkStreamWriteTransactionStatus>({
  from,
  to,
  takesMore
}: {
  from: TPumpSource<T>;
  to: TPumpSink<T, X>;
  takesMore: () => boolean;
}): TPumpPoll => {
  return ({ onUpdate }) => {
    const pumpable = isPumpable({ fromType: from.status().type, toType: to.status().type });

    if (pumpable && !takesMore()) {
      return to.poll({ onUpdate });
    }

    return createPollRegistry().poll({ onUpdate, ready: true });
  };
};

// pump() combined with a binary stream pressure gauge keeping track of the bytes not committed yet,
// the gauge keeps track of the transactions of all maybePump() calls, e.g. of multiple froms pumped into the same to
const createBinaryStreamPressureGaugePump = ({
  lowWatermark,
  highWatermark
}: {
  lowWatermark: number;
  highWatermark: number;
}): TBinaryStreamPressureGaugePump => {
  const gauge = createBinaryStreamPressureGauge({ lowWatermark, highWatermark });

  const maybePump: TBinaryStreamPressureGaugePump["maybePump"] = ({ from, to }) => {
    checkPumpable({ fromType: from.status().type, toType: to.status().type });

    if (!gauge.takesMore() && !isExhausted({ fromType: from.status().type })) {
      return { transaction: undefined, poll: pollWhileFull({ from, to, takesMore: gauge.takesMore }) };
    }

    const pumpResult = pump({ from, to });
    gauge.reportPumpResult({ pumpResult });

    return { transaction: pumpResult.transaction, poll: pumpResult.poll };
  };

  return {
    maybePump
  };
};

export type {
  TBinaryStreamPressureGaugePump,
  TBinaryStreamPressureGaugePumpResult
};

export {
  createBinaryStreamPressureGaugePump
};
