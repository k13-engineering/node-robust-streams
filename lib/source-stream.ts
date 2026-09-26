import {
  createGuardContext,
  guardMethod,
  guardPoll,
  guardRead,
  ignore
} from "./guard.ts";
import type { TTransition } from "./guard.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import type { TPollHandle } from "./poll.ts";

type TSourceStreamStatus = {
  type: "opening"
} | {
  type: "open"
} | {
  type: "ending"
} | {
  type: "ended"
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
//  - open -> ending
//  - open -> failing
//  - open -> destroying
//  - ending -> ended
//  - ending -> failing
//  - ending -> destroying
//  - failing -> failed
//  - failing -> destroying
//  - destroying -> destroyed

// status rules:
//  - ending MUST NOT be entered before all chunks have been read
//  - ended, failed and destroyed MUST NOT be entered before:
//     - all OS level resources (e.g. file descriptors, sockets) have been released
//     - no timers or other scheduled work remain, except the triggering of pending polls
//     - all auxiliary artifacts the stream created for itself (e.g. temp files, lock files, leases)
//       have been cleaned up

// io rules:
//  - the stream drives IO on its own, calls of any kind (e.g. read(), poll() or an own start() method)
//    MUST NOT be required to start or continue IO
//  - data SHOULD stay in a kernel buffer until read() is called
//  - if that is not possible, the stream MUST buffer internally and stop taking in data once its buffer limit is reached
//    (buffer limits are part of a higher layer)

type TSourceStreamReadResult<T extends TStreamChunk> = {
  chunks: readonly T[];
};

type TSourceStream<T extends TStreamChunk> = {
  // MUST yield the same result until either:
  //  - a method of this interface is called
  //  - the implementation changes it by itself (e.g. an own update() method or an IO callback)
  // i.e. if you repeatedly call status() and nothing else, the result MUST NOT change
  // the returned object MUST NOT be modified afterwards, it MAY be a new object on every call
  status: () => TSourceStreamStatus;

  // MUST NOT be called in:
  //  - status opening
  //  - status ending
  //  - status ended
  //  - status failing
  //  - status failed
  //  - status destroying
  //  - status destroyed
  // MAY return an empty chunks array
  read: () => TSourceStreamReadResult<T>;

  // MUST NOT be called in:
  //  - status ended
  //  - status failed
  //  - status destroyed
  // MUST NOT change the status synchronously
  // the poll MUST be triggered (unless cancelled) as soon as one of the following is true:
  //  - status() changed since poll() was called (compared by value, not by object identity)
  //  - read() would return chunks
  // the poll MAY be triggered spuriously, but MUST NOT be triggered by busy polling (e.g. setInterval(..., 0))
  // onUpdate MUST NOT be called synchronously, neither within poll() nor within any other method of this interface
  // multiple polls MAY be pending at the same time, each of them MUST be triggered
  // all methods of this interface, including poll(), MAY be called from within onUpdate, the stream MUST handle this
  poll: (args: { onUpdate: () => void }) => TPollHandle;

  // MUST NOT be called in:
  //  - status ended
  //  - status failed
  //  - status destroying
  //  - status destroyed
  destroy: () => void;
};

const SOURCE_TRANSITIONS: readonly TTransition[] = [
  ["opening", "open"],
  ["opening", "failing"],
  ["opening", "destroying"],
  ["open", "ending"],
  ["open", "failing"],
  ["open", "destroying"],
  ["ending", "ended"],
  ["ending", "failing"],
  ["ending", "destroying"],
  ["failing", "failed"],
  ["failing", "destroying"],
  ["destroying", "destroyed"]
];

// enforces the contract of the source stream, a violation throws and is meant to crash the process
const sourceGuard = <T extends TStreamChunk>({ source }: { source: TSourceStream<T> }): TSourceStream<T> => {
  const ctx = createGuardContext<TSourceStreamStatus>({
    spec: { name: "source", transitions: SOURCE_TRANSITIONS },
    status: source.status,
    onObserve: ignore
  });

  return {
    status: ctx.observe,
    read: guardRead({
      ctx,
      forbidden: ["opening", "ending", "ended", "failing", "failed", "destroying", "destroyed"],
      read: source.read
    }),
    poll: guardPoll({ name: "source", ctx, forbidden: ["ended", "failed", "destroyed"], poll: source.poll }),
    destroy: guardMethod({ ctx, method: "destroy", forbidden: ["ended", "failed", "destroying", "destroyed"], fn: source.destroy })
  };
};

export type {
  TSourceStream,
  TSourceStreamReadResult,
  TSourceStreamStatus
};

export {
  sourceGuard
};
