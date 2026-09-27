import { violation } from "./guard.ts";
import type { TPollHandle } from "./poll.ts";
import { createPollRegistry } from "./poll-registry.ts";
import type {
  TSinkStream,
  TSinkStreamStatus,
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";
import type { TSourceStream, TSourceStreamStatus } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import { createStreamPressureGauge } from "./stream-pressure-gauge.ts";
import type { TDuplexStream, TDuplexStreamStatus } from "./duplex-stream.ts";

type TPumpSource<T extends TStreamChunk> = TSourceStream<T> | TDuplexStream<never, T>;
type TPumpSink<
  T extends TStreamChunk,
  X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus
> = TSinkStream<T, TSinkStreamStatus, X> | TDuplexStream<T, TStreamChunk, TDuplexStreamStatus, X>;

// issues the poll the next pump() call waits for, on either from or to:
//  - onUpdate is called once pump() should be called again, never synchronously
//  - if the next call can proceed right away (e.g. to end to), once to has been ended or if a stream broke,
//    onUpdate is called right away, so the caller notices the statuses right away
//  - what to wait for is decided when poll() is called, so it may also be called later
type TPumpPoll = (args: { onUpdate: () => void }) => TPollHandle;

// the result of a single step, done tells runPump() that to has been ended
type TPumpStep<T extends TStreamChunk, X extends TSinkStreamWriteTransactionStatus> = {
  type: "done";
} | {
  type: "transaction";
  transaction: TSinkStreamWriteTransaction<X>;
  chunks: readonly T[];
} | {
  type: "nothing";
};

type TPumpResult<
  T extends TStreamChunk = TStreamChunk,
  X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus
> = {
  // the transaction returned by to, if chunks have been written to it
  transaction: TSinkStreamWriteTransaction<X> | undefined;

  // the chunks written with the transaction, empty without a transaction
  chunks: readonly T[];

  // issues the poll the next pump() call waits for
  poll: TPumpPoll;
};

// the statuses assertPumpable() accepts, a status with own properties (e.g. { type: "open", remainingChunks: 3 }) fits as well
type TPumpableFromStatus = Extract<TSourceStreamStatus | TDuplexStreamStatus, { type: "opening" | "open" }>;

type TPumpableToStatus = Extract<TSinkStreamStatus | TDuplexStreamStatus, { type: "opening" | "open" }>;

type TRunPumpResult = {
  type: "finished";
} | {
  type: "failed";
  side: "from" | "to";
};

const FROM_ALLOWED = ["opening", "open", "ending", "ended", "flushing", "done"];
const FROM_ASSERTABLE = ["opening", "open"];
const TO_ALLOWED = ["opening", "open"];
const READABLE = ["open", "flushing"];
const EXHAUSTED = ["ending", "ended", "done"];
const BROKEN = ["failing", "failed", "destroying", "destroyed"];
const COMPLETE = ["finished", "done"];
const FROM_NOT_POLLABLE = ["ended", "done"];

const DONE = Object.freeze({ type: "done" as const });
const NOTHING = Object.freeze({ type: "nothing" as const });
const NO_CHUNKS = Object.freeze([]);

const checkPumpable = ({ fromType, toType }: { fromType: string; toType: string }) => {
  if (!FROM_ALLOWED.includes(fromType)) {
    throw violation({ message: `pump() MUST NOT be called when from is in status ${fromType}` });
  }

  if (!TO_ALLOWED.includes(toType)) {
    throw violation({ message: `pump() MUST NOT be called when to is in status ${toType}` });
  }
};

// checks the statuses of from and to before calling pump(), its types only accept from and to in opening or open,
// so all other statuses have to be handled before (e.g. by narrowing them away), otherwise it does not compile,
// at runtime, it throws a contract violation for all other statuses as well (e.g. if the types were bypassed)
// pump() itself may also be called while from is ending, ended, flushing or done, e.g. to end to
const assertPumpable = ({ fromStatus, toStatus }: { fromStatus: TPumpableFromStatus; toStatus: TPumpableToStatus }) => {
  checkPumpable({ fromType: fromStatus.type, toType: toStatus.type });

  if (!FROM_ASSERTABLE.includes(fromStatus.type)) {
    throw violation({ message: `from MUST be opening or open for assertPumpable(), but is in status ${fromStatus.type}` });
  }
};

const transfer = <T extends TStreamChunk, X extends TSinkStreamWriteTransactionStatus>({
  from,
  to
}: {
  from: TPumpSource<T>;
  to: TPumpSink<T, X>;
}): TPumpStep<T, X> | undefined => {
  if (!READABLE.includes(from.status().type)) {
    return undefined;
  }

  const { chunks } = from.read();

  if (chunks.length === 0) {
    return undefined;
  }

  return { type: "transaction", transaction: to.write({ chunks }), chunks };
};

const pumpOnce = <T extends TStreamChunk, X extends TSinkStreamWriteTransactionStatus>({
  from,
  to
}: {
  from: TPumpSource<T>;
  to: TPumpSink<T, X>;
}): TPumpStep<T, X> => {
  checkPumpable({ fromType: from.status().type, toType: to.status().type });

  if (to.status().type === "opening") {
    return NOTHING;
  }

  const written = transfer({ from, to });

  if (written !== undefined) {
    return written;
  }

  if (!EXHAUSTED.includes(from.status().type)) {
    return NOTHING;
  }

  to.end();

  return DONE;
};

const isPumpable = ({ fromType, toType }: { fromType: string; toType: string }) => {
  return FROM_ALLOWED.includes(fromType) && TO_ALLOWED.includes(toType);
};

// whether from will not provide chunks anymore, so that pump() only ends to
const isExhausted = ({ fromType }: { fromType: string }) => {
  return EXHAUSTED.includes(fromType);
};

// what the next pump() call waits for:
//  - now, if it can proceed right away (from is exhausted) or if the streams broke, so the caller notices right away
//  - to, while to is opening
//  - from otherwise, its poll also triggers right away if it has data to read already
const nextWaitFor = <T extends TStreamChunk, X extends TSinkStreamWriteTransactionStatus>({
  from,
  to
}: {
  from: TPumpSource<T>;
  to: TPumpSink<T, X>;
}) => {
  if (!isPumpable({ fromType: from.status().type, toType: to.status().type })) {
    return "now";
  }

  if (to.status().type === "opening") {
    return "to";
  }

  return EXHAUSTED.includes(from.status().type) ? "now" : "from";
};

const createNextPoll = <T extends TStreamChunk, X extends TSinkStreamWriteTransactionStatus>({
  from,
  to
}: {
  from: TPumpSource<T>;
  to: TPumpSink<T, X>;
}): TPumpPoll => {
  return ({ onUpdate }) => {
    const polls = {
      now: () => {
        return createPollRegistry().poll({ onUpdate, ready: true });
      },
      to: () => {
        return to.poll({ onUpdate });
      },
      from: () => {
        return from.poll({ onUpdate });
      }
    };

    return polls[nextWaitFor({ from, to })]();
  };
};

// MUST NOT be called unless from is in:
//  - status opening
//  - status open
//  - status ending (if source)
//  - status ended (if source)
//  - status flushing (if duplex)
//  - status done (if duplex)
// MUST NOT be called unless to is in:
//  - status opening
//  - status open
// moves all chunks from can currently provide to to:
//  - if chunks have been written, the transaction returned by to is returned together with the chunks,
//    otherwise the transaction is undefined and the chunks are empty
//  - once from will not provide chunks anymore, to is ended, this only happens in a call that did not write chunks,
//    so it may take one more call after the last chunks have been written, afterwards to is not opening or open
//    anymore, so pump() MUST NOT be called anymore for these streams
// the result always carries a poll() method issuing the poll the next pump() call waits for, once to has been ended,
// it triggers right away, so the caller notices the status of to right away
const pump = <T extends TStreamChunk, X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus>({
  from,
  to
}: {
  from: TPumpSource<T>;
  to: TPumpSink<T, X>;
}): TPumpResult<T, X> => {
  const step = pumpOnce({ from, to });
  const written = step.type === "transaction" ? step : { transaction: undefined, chunks: NO_CHUNKS };

  return { transaction: written.transaction, chunks: written.chunks, poll: createNextPoll({ from, to }) };
};

// drives the steps of pump() until to is complete (finished or done) or one of the streams broke (failed or was destroyed)
//  - pump() is only called while less than maxPending transactions of to are pending
//  - a broken stream does not cause the other stream to be ended or destroyed, this is up to the caller
//  - the returned promise never rejects, failures are reported through the result
const runPump = <T extends TStreamChunk>({
  from,
  to,
  maxPending = 1
}: {
  from: TPumpSource<T>;
  to: TPumpSink<T>;
  maxPending?: number;
}): Promise<TRunPumpResult> => {
  return new Promise((resolve) => {
    const gauge = createStreamPressureGauge();
    let done = false;

    const outcome = (): TRunPumpResult | undefined => {
      if (COMPLETE.includes(to.status().type)) {
        return { type: "finished" };
      }

      if (BROKEN.includes(from.status().type)) {
        return { type: "failed", side: "from" };
      }

      if (BROKEN.includes(to.status().type)) {
        return { type: "failed", side: "to" };
      }

      return undefined;
    };

    const mayPump = () => {
      return !done && gauge.pending().length < maxPending;
    };

    // pump() may change statuses synchronously, e.g. to.end() or from.read() might complete or break a stream,
    // which then MUST NOT be pumped or polled anymore
    const canPump = () => {
      return outcome() === undefined && mayPump();
    };

    const handle = ({ step }: { step: TPumpStep<T, TSinkStreamWriteTransactionStatus> }) => {
      if (step.type === "transaction") {
        gauge.report({ transaction: step.transaction });
      }

      done = step.type === "done";
    };

    // once the last chunks have been written, there is no update of from left to wait for,
    // so pump() is called again right away to end to
    const pumpNow = (): void => {
      if (!canPump()) {
        return;
      }

      const step = pumpOnce({ from, to });
      handle({ step });

      if (step.type === "transaction" && EXHAUSTED.includes(from.status().type)) {
        pumpNow();
      }
    };

    // from is only polled while pump() would read from it, polling it otherwise would trigger right away
    // again and again as long as it has data to read
    const pollTargets = () => {
      const pollFrom = mayPump() && !FROM_NOT_POLLABLE.includes(from.status().type);
      return pollFrom ? [to, from] : [to];
    };

    const waitForUpdate = ({ onUpdate }: { onUpdate: () => void }) => {
      let woken = false;
      let handles: readonly TPollHandle[] = [];

      const wake = () => {
        // a second poll may already be triggered, so it can not be cancelled anymore
        if (woken) {
          return;
        }

        woken = true;
        handles.filter((pollHandle) => {
          return pollHandle.status().type === "pending";
        }).forEach((pollHandle) => {
          pollHandle.cancel();
        });
        onUpdate();
      };

      handles = pollTargets().map((stream) => {
        return stream.poll({ onUpdate: wake });
      });
    };

    const step = (): void => {
      pumpNow();

      const result = outcome();

      if (result !== undefined) {
        resolve(result);
        return;
      }

      waitForUpdate({ onUpdate: step });
    };

    step();
  });
};

export type {
  TPumpPoll,
  TPumpableFromStatus,
  TPumpableToStatus,
  TPumpResult,
  TPumpSink,
  TPumpSource,
  TRunPumpResult
};

export {
  assertPumpable,
  pump,
  runPump
};

// for pumps built on top of pump(), not part of the public api
export {
  checkPumpable,
  isExhausted,
  isPumpable
};
