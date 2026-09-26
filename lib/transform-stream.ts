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
import type { TSinkStreamWriteTransaction } from "./sink-stream.ts";
import type { TSourceStreamReadResult } from "./source-stream.ts";

type TTransformStreamStatus = {
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
//  - a transaction is committed once all data resulting from its chunks has been read() out of the transform,
//    if its chunks result in no data, it is committed once they have been processed
//  - written chunks MUST be processed in the order they were written
//  - transactions MUST be committed in the order they were written: a transaction MUST stay pending
//    until all previously written transactions are committed
//  - a transaction MAY be pending in any non-final status of the stream
//  - a transaction MUST end as committed or discarded and MUST NOT be pending in a final status (done, failed, destroyed)
//  - a transaction MUST NOT be discarded unless the stream is failed or destroyed

type TTransformStream<T extends TStreamChunk, U extends TStreamChunk> = {
  // MUST yield the same result until either:
  //  - a method of this interface is called
  //  - the implementation changes it by itself (e.g. an own update() method or an IO callback)
  // i.e. if you repeatedly call status() and nothing else, the result MUST NOT change
  // the returned object MUST NOT be modified afterwards, it MAY be a new object on every call
  status: () => TTransformStreamStatus;

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
  write: (args: { chunks: readonly T[] }) => TSinkStreamWriteTransaction;

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

const TRANSFORM_TRANSITIONS: readonly TTransition[] = [
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

const TRANSFORM_WRITE_INACTIVE = ["opening", "flushing", "done", "failing", "failed", "destroying", "destroyed"];

// enforces the contract of the transform stream, a violation throws and is meant to crash the process
const transformGuard = <T extends TStreamChunk, U extends TStreamChunk>({
  transform
}: {
  transform: TTransformStream<T, U>
}): TTransformStream<T, U> => {
  const transactions = createTransactionTracker({
    name: "transform",
    completeStatus: "done",
    finalStatuses: ["done", "failed", "destroyed"],
    streamStatus: transform.status
  });

  const ctx = createGuardContext<TTransformStreamStatus>({
    spec: { name: "transform", transitions: TRANSFORM_TRANSITIONS },
    status: transform.status,
    onObserve: transactions.checkStream
  });

  return {
    status: ctx.observe,
    read: guardRead({
      ctx,
      forbidden: ["opening", "done", "failing", "failed", "destroying", "destroyed"],
      read: transform.read
    }),
    write: guardWrite({ name: "transform", ctx, forbidden: TRANSFORM_WRITE_INACTIVE, write: transform.write, transactions }),
    end: guardMethod({ ctx, method: "end", forbidden: TRANSFORM_WRITE_INACTIVE, fn: transform.end }),
    poll: guardPoll({ name: "transform", ctx, forbidden: ["done", "failed", "destroyed"], poll: transform.poll }),
    destroy: guardMethod({ ctx, method: "destroy", forbidden: ["done", "failed", "destroying", "destroyed"], fn: transform.destroy })
  };
};

export type {
  TTransformStream,
  TTransformStreamStatus
};

export {
  transformGuard
};
