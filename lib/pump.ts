import { violation } from "./guard.ts";
import type { TPollHandle } from "./poll.ts";
import type { TSinkStream, TSinkStreamWriteTransaction } from "./sink-stream.ts";
import type { TSourceStream } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import type { TTransformStream } from "./transform-stream.ts";

type TPumpSource<T extends TStreamChunk> = TSourceStream<T> | TTransformStream<never, T>;
type TPumpSink<T extends TStreamChunk> = TSinkStream<T> | TTransformStream<T, TStreamChunk>;

type TPumpResult = {
  done: boolean;
};

type TPump = {
  // returns the transactions of to that are still pending
  pending: () => readonly TSinkStreamWriteTransaction[];

  // MUST NOT be called unless from is in:
  //  - status opening
  //  - status open
  //  - status ending (if source)
  //  - status ended (if source)
  //  - status flushing (if transform)
  //  - status done (if transform)
  // MUST NOT be called unless to is in:
  //  - status opening
  //  - status open
  // moves all chunks from can currently provide to to, once from will not provide chunks anymore,
  // to is ended and done is true, afterwards pump() MUST NOT be called anymore
  pump: () => TPumpResult;
};

type TRunPumpResult = {
  type: "finished";
} | {
  type: "failed";
  side: "from" | "to";
};

const FROM_ALLOWED = ["opening", "open", "ending", "ended", "flushing", "done"];
const TO_ALLOWED = ["opening", "open"];
const READABLE = ["open", "flushing"];
const EXHAUSTED = ["ending", "ended", "done"];
const BROKEN = ["failing", "failed", "destroying", "destroyed"];
const COMPLETE = ["finished", "done"];
const FROM_NOT_POLLABLE = ["ended", "done"];

const createPump = <T extends TStreamChunk>({ from, to }: { from: TPumpSource<T>; to: TPumpSink<T> }): TPump => {
  let transactions: readonly TSinkStreamWriteTransaction[] = [];

  const pending = () => {
    transactions = transactions.filter((transaction) => {
      return transaction.status().type === "pending";
    });

    return transactions;
  };

  const checkAllowed = () => {
    const fromType = from.status().type;
    const toType = to.status().type;

    if (!FROM_ALLOWED.includes(fromType)) {
      throw violation({ message: `pump() MUST NOT be called when from is in status ${fromType}` });
    }

    if (!TO_ALLOWED.includes(toType)) {
      throw violation({ message: `pump() MUST NOT be called when to is in status ${toType}` });
    }
  };

  const transfer = () => {
    if (!READABLE.includes(from.status().type)) {
      return;
    }

    const { chunks } = from.read();

    if (chunks.length === 0) {
      return;
    }

    transactions = [...transactions, to.write({ chunks })];
  };

  const pump = (): TPumpResult => {
    checkAllowed();

    if (to.status().type === "opening") {
      return { done: false };
    }

    transfer();

    if (!EXHAUSTED.includes(from.status().type)) {
      return { done: false };
    }

    to.end();

    return { done: true };
  };

  return {
    pending,
    pump
  };
};

// drives a pump until to is complete (finished or done) or one of the streams broke (failed or was destroyed)
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
    const { pending, pump } = createPump({ from, to });
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
      return !done && pending().length < maxPending;
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
        handles.filter((handle) => {
          return handle.status().type === "pending";
        }).forEach((handle) => {
          handle.cancel();
        });
        onUpdate();
      };

      handles = pollTargets().map((stream) => {
        return stream.poll({ onUpdate: wake });
      });
    };

    const step = (): void => {
      if (outcome() === undefined && mayPump()) {
        done = pump().done;
      }

      // pump() may have changed the statuses synchronously, e.g. to.end() or from.read() might have completed
      // or broken a stream, which then MUST NOT be polled anymore
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
  TPump,
  TPumpResult,
  TPumpSink,
  TPumpSource,
  TRunPumpResult
};

export {
  createPump,
  runPump
};
