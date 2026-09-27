import {
  createGuardContext,
  createTransactionTracker,
  guardMethod,
  guardPoll,
  guardRead,
  guardWrite
} from "./guard.ts";
import type { TTransition } from "./guard.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import type { TPollHandle } from "./poll.ts";
import type {
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";
import type { TSourceStreamReadResult } from "./source-stream.ts";

type TDuplexStreamStatus = {
  type: "opening"
} | {
  type: "open"
} | {
  type: "flushing"
} | {
  type: "done"
} | {
  type: "failing"
} | {
  type: "failed"
} | {
  type: "destroying"
} | {
  type: "destroyed"
};

// allowed status transitions:
//  - opening -> open
//  - opening -> failing
//  - opening -> destroying
//  - open -> flushing
//  - open -> failing
//  - open -> destroying
//  - flushing -> done
//  - flushing -> failing
//  - flushing -> destroying
//  - failing -> failed
//  - failing -> destroying
//  - destroying -> destroyed

// status rules:
//  - done MUST NOT be entered before all chunks have been read
//  - done MUST NOT be entered before all transactions have been committed
//  - done, failed and destroyed MUST NOT be entered before:
//     - all OS level resources (e.g. file descriptors, sockets) have been released
//     - no timers or other scheduled work remain, except the triggering of pending polls
//     - all auxiliary artifacts the stream created for itself (e.g. temp files, lock files, leases)
//       have been cleaned up

// io rules:
//  - the stream processes written chunks on its own, apart from write() and end(), calls of any kind
//    (e.g. read(), poll() or an own start() method) MUST NOT be required to start or continue processing

// transaction rules:
//  - a transaction is committed once all data resulting from its chunks has been read() out of the duplex,
//    if its chunks result in no data, it is committed once they have been processed
//  - written chunks MUST be processed in the order they were written
//  - transactions MUST be committed in the order they were written: a transaction MUST stay pending
//    until all previously written transactions are committed
//  - a transaction MAY be pending in any non-final status of the stream
//  - a transaction MUST end as committed or discarded and MUST NOT be pending in a final status (done, failed, destroyed)
//  - a transaction MUST NOT be discarded unless the stream is failed or destroyed

// S are the statuses the stream may yield, an implementation MAY declare a subset of them
// and MAY add own properties to them besides type (e.g. { type: "open", remainingChunks: 3 }):
//  - own properties MUST be plain data, as statuses are compared by value and are immutable
//  - own properties are part of the status, so the rules for status() and poll() apply to them as well
// X are the statuses the transactions of the stream may yield, like with S, an implementation MAY declare a subset
// of them and MAY add own properties to them besides type (e.g. { type: "committed", offset: 1024 })
type TDuplexStream<
  T extends TStreamChunk,
  U extends TStreamChunk,
  S extends TDuplexStreamStatus = TDuplexStreamStatus,
  X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus
> = {
  // MUST yield the same result until either:
  //  - a method of this interface is called
  //  - the implementation changes it by itself (e.g. an own update() method or an IO callback)
  // i.e. if you repeatedly call status() and nothing else, the result MUST NOT change
  // the returned object MUST NOT be modified afterwards, it MAY be a new object on every call
  status: () => S;

  // MUST NOT be called in:
  //  - status opening
  //  - status done
  //  - status failing
  //  - status failed
  //  - status destroying
  //  - status destroyed
  // MAY return an empty chunks array
  read: () => TSourceStreamReadResult<U>;

  // MUST NOT be called in:
  //  - status opening
  //  - status flushing
  //  - status done
  //  - status failing
  //  - status failed
  //  - status destroying
  //  - status destroyed
  // chunks MUST NOT be empty
  write: (args: { chunks: readonly T[] }) => TSinkStreamWriteTransaction<X>;

  // MUST NOT be called in:
  //  - status opening
  //  - status flushing
  //  - status done
  //  - status failing
  //  - status failed
  //  - status destroying
  //  - status destroyed
  end: () => void;

  // MUST NOT be called in:
  //  - status done
  //  - status failed
  //  - status destroyed
  // MUST NOT change the status synchronously
  // the poll MUST be triggered (unless cancelled) as soon as one of the following is true:
  //  - status() changed since poll() was called (compared by value, not by object identity)
  //  - read() would return chunks
  //  - the status of a transaction changed since poll() was called (compared by value, not by object identity)
  // the poll MAY be triggered spuriously, but MUST NOT be triggered by busy polling (e.g. setInterval(..., 0))
  // onUpdate MUST NOT be called synchronously, neither within poll() nor within any other method of this interface
  // multiple polls MAY be pending at the same time, each of them MUST be triggered
  // all methods of this interface, including poll(), MAY be called from within onUpdate, the stream MUST handle this
  poll: (args: { onUpdate: () => void }) => TPollHandle;

  // MUST NOT be called in:
  //  - status done
  //  - status failed
  //  - status destroying
  //  - status destroyed
  destroy: () => void;
};

const DUPLEX_TRANSITIONS: readonly TTransition[] = [
  ["opening", "open"],
  ["opening", "failing"],
  ["opening", "destroying"],
  ["open", "flushing"],
  ["open", "failing"],
  ["open", "destroying"],
  ["flushing", "done"],
  ["flushing", "failing"],
  ["flushing", "destroying"],
  ["failing", "failed"],
  ["failing", "destroying"],
  ["destroying", "destroyed"]
];

const DUPLEX_WRITE_INACTIVE = ["opening", "flushing", "done", "failing", "failed", "destroying", "destroyed"];

// enforces the contract of the duplex stream, a violation throws and is meant to crash the process
const duplexGuard = <
  T extends TStreamChunk,
  U extends TStreamChunk,
  S extends TDuplexStreamStatus,
  X extends TSinkStreamWriteTransactionStatus
>({ duplex }: { duplex: TDuplexStream<T, U, S, X> }): TDuplexStream<T, U, S, X> => {
  const transactions = createTransactionTracker<X>({
    name: "duplex",
    completeStatus: "done",
    finalStatuses: ["done", "failed", "destroyed"],
    streamStatus: duplex.status
  });

  const ctx = createGuardContext<S>({
    spec: { name: "duplex", transitions: DUPLEX_TRANSITIONS },
    status: duplex.status,
    onObserve: transactions.checkStream
  });

  return {
    status: ctx.observe,
    read: guardRead({
      ctx,
      forbidden: ["opening", "done", "failing", "failed", "destroying", "destroyed"],
      read: duplex.read
    }),
    write: guardWrite({ name: "duplex", ctx, forbidden: DUPLEX_WRITE_INACTIVE, write: duplex.write, transactions }),
    end: guardMethod({ ctx, method: "end", forbidden: DUPLEX_WRITE_INACTIVE, fn: duplex.end }),
    poll: guardPoll({ name: "duplex", ctx, forbidden: ["done", "failed", "destroyed"], poll: duplex.poll }),
    destroy: guardMethod({ ctx, method: "destroy", forbidden: ["done", "failed", "destroying", "destroyed"], fn: duplex.destroy })
  };
};

export type {
  TDuplexStream,
  TDuplexStreamStatus
};

export {
  duplexGuard
};
