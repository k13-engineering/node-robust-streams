import {
  createGuardContext,
  createTransactionTracker,
  guardMethod,
  guardPoll,
  guardWrite
} from "./guard.ts";
import type { TTransition } from "./guard.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import type { TPollHandle } from "./poll.ts";

type TSinkStreamStatus = {
  type: "opening"
} | {
  type: "open"
} | {
  type: "finishing"
} | {
  type: "finished"
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
//  - open -> finishing
//  - open -> failing
//  - open -> destroying
//  - finishing -> finished
//  - finishing -> failing
//  - finishing -> destroying
//  - failing -> failed
//  - failing -> destroying
//  - destroying -> destroyed

// status rules:
//  - finished MUST NOT be entered before all transactions have been committed
//  - finished, failed and destroyed MUST NOT be entered before:
//     - all OS level resources (e.g. file descriptors, sockets) have been released
//     - no timers or other scheduled work remain, except the triggering of pending polls
//     - all auxiliary artifacts the stream created for itself (e.g. temp files, lock files, leases)
//       have been cleaned up

type TSinkStreamWriteTransactionStatus = {
  type: "pending"
} | {
  type: "committed"
} | {
  type: "discarded"
};

// allowed status transitions:
//  - pending -> committed
//  - pending -> discarded

// transaction rules:
//  - a transaction is committed once an outside entity (e.g. the kernel) has accepted its chunks in a way that
//    an application crash can no longer lose them (a power outage still might), handing them over is not enough
//    (e.g. data still queued in a userland buffer, rows sent to a database before COMMIT)
//  - a committed transaction MAY still be lost if the stream fails afterwards (e.g. write-back errors reported
//    by fsync() or close()), such a loss is only reported through the failing status
//  - a discarded transaction MAY have reached the outside entity partially or completely, delivery is at-least-once
//  - the result at the outside entity MUST reflect the order in which the chunks were written,
//    the hand-over itself MAY happen in a different order (e.g. parallel positional writes)
//  - transactions MUST be committed in the order they were written: a transaction MUST stay pending
//    until all previously written transactions are committed, even if its own chunks were already handed over
//  - a transaction MAY be pending in any non-final status of the stream
//  - a transaction MUST end as committed or discarded and MUST NOT be pending in a final status (finished, failed, destroyed)
//  - a transaction MUST NOT be discarded unless the stream is failed or destroyed

type TSinkStreamWriteTransaction = {
  // MUST yield the same result until either:
  //  - a method of the stream that created this transaction is called
  //  - that stream changes it by itself (e.g. an own update() method or an IO callback)
  // i.e. if you repeatedly call status() and nothing else, the result MUST NOT change
  // the returned object MUST NOT be modified afterwards, it MAY be a new object on every call
  status: () => TSinkStreamWriteTransactionStatus;
};

// S are the statuses the stream may yield, an implementation MAY declare a subset of them
// and MAY add own properties to them besides type (e.g. { type: "open", remainingChunks: 3 }):
//  - own properties MUST be plain data, as statuses are compared by value and are immutable
//  - own properties are part of the status, so the rules for status() and poll() apply to them as well
type TSinkStream<T extends TStreamChunk, S extends TSinkStreamStatus = TSinkStreamStatus> = {
  // MUST yield the same result until either:
  //  - a method of this interface is called
  //  - the implementation changes it by itself (e.g. an own update() method or an IO callback)
  // i.e. if you repeatedly call status() and nothing else, the result MUST NOT change
  // the returned object MUST NOT be modified afterwards, it MAY be a new object on every call
  status: () => S;

  // MUST NOT be called in:
  //  - status opening
  //  - status finishing
  //  - status finished
  //  - status failing
  //  - status failed
  //  - status destroying
  //  - status destroyed
  // chunks MUST NOT be empty
  write: (args: { chunks: readonly T[] }) => TSinkStreamWriteTransaction;

  // MUST NOT be called in:
  //  - status opening
  //  - status finishing
  //  - status finished
  //  - status failing
  //  - status failed
  //  - status destroying
  //  - status destroyed
  end: () => void;

  // MUST NOT be called in:
  //  - status finished
  //  - status failed
  //  - status destroyed
  // MUST NOT change the status synchronously
  // the poll MUST be triggered (unless cancelled) as soon as one of the following is true:
  //  - status() changed since poll() was called (compared by value, not by object identity)
  //  - the status of a transaction changed since poll() was called (compared by value, not by object identity)
  // the poll MAY be triggered spuriously, but MUST NOT be triggered by busy polling (e.g. setInterval(..., 0))
  // onUpdate MUST NOT be called synchronously, neither within poll() nor within any other method of this interface
  // multiple polls MAY be pending at the same time, each of them MUST be triggered
  // all methods of this interface, including poll(), MAY be called from within onUpdate, the stream MUST handle this
  poll: (args: { onUpdate: () => void }) => TPollHandle;

  // MUST NOT be called in:
  //  - status finished
  //  - status failed
  //  - status destroying
  //  - status destroyed
  destroy: () => void;
};

const SINK_TRANSITIONS: readonly TTransition[] = [
  ["opening", "open"],
  ["opening", "failing"],
  ["opening", "destroying"],
  ["open", "finishing"],
  ["open", "failing"],
  ["open", "destroying"],
  ["finishing", "finished"],
  ["finishing", "failing"],
  ["finishing", "destroying"],
  ["failing", "failed"],
  ["failing", "destroying"],
  ["destroying", "destroyed"]
];

const SINK_INACTIVE = ["opening", "finishing", "finished", "failing", "failed", "destroying", "destroyed"];

// enforces the contract of the sink stream, a violation throws and is meant to crash the process
const sinkGuard = <T extends TStreamChunk, S extends TSinkStreamStatus>({ sink }: { sink: TSinkStream<T, S> }): TSinkStream<T, S> => {
  const transactions = createTransactionTracker({
    name: "sink",
    completeStatus: "finished",
    finalStatuses: ["finished", "failed", "destroyed"],
    streamStatus: sink.status
  });

  const ctx = createGuardContext<S>({
    spec: { name: "sink", transitions: SINK_TRANSITIONS },
    status: sink.status,
    onObserve: transactions.checkStream
  });

  return {
    status: ctx.observe,
    write: guardWrite({ name: "sink", ctx, forbidden: SINK_INACTIVE, write: sink.write, transactions }),
    end: guardMethod({ ctx, method: "end", forbidden: SINK_INACTIVE, fn: sink.end }),
    poll: guardPoll({ name: "sink", ctx, forbidden: ["finished", "failed", "destroyed"], poll: sink.poll }),
    destroy: guardMethod({ ctx, method: "destroy", forbidden: ["finished", "failed", "destroying", "destroyed"], fn: sink.destroy })
  };
};

export type {
  TSinkStream,
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus,
  TSinkStreamStatus
};

export {
  sinkGuard
};
