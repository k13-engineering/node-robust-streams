import { open } from "node:fs/promises";
import { createPollRegistry } from "../lib/poll-registry.ts";
import type {
  TSinkStream,
  TSinkStreamStatus,
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "../lib/sink-stream.ts";
import type { TBinaryStreamChunk } from "../lib/stream-chunk.ts";

type TFileSinkHandle = {
  write: (data: Uint8Array) => Promise<{ bytesWritten: number }>;
  close: () => Promise<void>;
};

type TFileSinkState = {
  status: TSinkStreamStatus;
  handle: TFileSinkHandle | undefined;
  queue: readonly (readonly TBinaryStreamChunk[])[];
  busy: boolean;
  written: number;
  committed: number;
};

type TWriteCallbacks = {
  onWritten: () => void;
  onFailed: () => void;
  onInterrupted: () => void;
};

const OPENING: TSinkStreamStatus = Object.freeze({ type: "opening" });
const OPEN: TSinkStreamStatus = Object.freeze({ type: "open" });
const FINISHING: TSinkStreamStatus = Object.freeze({ type: "finishing" });
const FINISHED: TSinkStreamStatus = Object.freeze({ type: "finished" });
const FAILING: TSinkStreamStatus = Object.freeze({ type: "failing" });
const FAILED: TSinkStreamStatus = Object.freeze({ type: "failed" });
const DESTROYING: TSinkStreamStatus = Object.freeze({ type: "destroying" });
const DESTROYED: TSinkStreamStatus = Object.freeze({ type: "destroyed" });

const PENDING: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "pending" });
const COMMITTED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "committed" });
const DISCARDED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "discarded" });

// the final status a closing sink enters, depending on whether close() succeeded
const CLOSE_OUTCOMES = {
  finishing: { succeeded: FINISHED, failed: FAILED },
  failing: { succeeded: FAILED, failed: FAILED },
  destroying: { succeeded: DESTROYED, failed: DESTROYED }
};

const RELEASING = ["failing", "destroying"];
const WRITABLE = ["open", "finishing"];
const DISCARDING = ["failed", "destroyed"];

const transactionStatus = ({ index, state }: { index: number; state: TFileSinkState }) => {
  if (index < state.committed) {
    return COMMITTED;
  }

  if (DISCARDING.includes(state.status.type)) {
    return DISCARDED;
  }

  return PENDING;
};

const closeOutcome = ({ status, succeeded }: { status: TSinkStreamStatus; succeeded: boolean }) => {
  const outcomes = CLOSE_OUTCOMES[status.type as keyof typeof CLOSE_OUTCOMES];
  return succeeded ? outcomes.succeeded : outcomes.failed;
};

const idleAction = ({ state }: { state: TFileSinkState }) => {
  if (state.queue.length > 0) {
    return "write";
  }

  return state.status === FINISHING ? "close" : "wait";
};

const nextAction = ({ state }: { state: TFileSinkState }) => {
  if (state.busy) {
    return "wait";
  }

  if (RELEASING.includes(state.status.type)) {
    return "close";
  }

  return idleAction({ state });
};

// writes data completely, a partial write is continued with the remaining bytes
const writeData = ({
  handle,
  data,
  onWritten,
  onFailed
}: {
  handle: TFileSinkHandle;
  data: Uint8Array;
  onWritten: () => void;
  onFailed: () => void;
}) => {
  handle.write(data).then(({ bytesWritten }) => {
    if (bytesWritten < data.length) {
      writeData({ handle, data: data.subarray(bytesWritten), onWritten, onFailed });
      return;
    }

    onWritten();
  }, onFailed);
};

const writeChunks = ({
  handle,
  chunks,
  isWritable,
  callbacks
}: {
  handle: TFileSinkHandle;
  chunks: readonly TBinaryStreamChunk[];
  isWritable: () => boolean;
  callbacks: TWriteCallbacks;
}) => {
  if (!isWritable()) {
    callbacks.onInterrupted();
    return;
  }

  if (chunks.length === 0) {
    callbacks.onWritten();
    return;
  }

  const [first, ...rest] = chunks;

  writeData({
    handle,
    data: first.data,
    onWritten: () => {
      writeChunks({ handle, chunks: rest, isWritable, callbacks });
    },
    onFailed: callbacks.onFailed
  });
};

// sample sink writing binary chunks to a file
//  - a transaction is committed once the kernel has accepted all of its bytes (partial writes are continued)
//  - writes are serialized, so the file content reflects the order in which the chunks were written
//  - the file descriptor is only closed once no operation on it is in flight anymore
//  - finished, failed and destroyed are only entered once close() has settled
//  - errors of the file system are reported through the failing status, they are never thrown
const createFileSink = ({ path }: { path: string }): TSinkStream<TBinaryStreamChunk> => {
  const polls = createPollRegistry();

  let state: TFileSinkState = {
    status: OPENING,
    handle: undefined,
    queue: [],
    busy: true,
    written: 0,
    committed: 0
  };

  const update = ({ changes }: { changes: Partial<TFileSinkState> }) => {
    state = { ...state, ...changes };
    polls.notify();
  };

  const settleClose = ({ succeeded }: { succeeded: boolean }) => {
    update({
      changes: {
        busy: false,
        handle: undefined,
        queue: [],
        status: closeOutcome({ status: state.status, succeeded })
      }
    });
  };

  const startClose = () => {
    const handle = state.handle!;

    update({ changes: { busy: true } });
    handle.close().then(() => {
      settleClose({ succeeded: true });
    }, () => {
      settleClose({ succeeded: false });
    });
  };

  const commitFirst = () => {
    update({ changes: { busy: false, queue: state.queue.slice(1), committed: state.committed + 1 } });
  };

  const failWrite = () => {
    update({ changes: { busy: false, status: state.status === DESTROYING ? DESTROYING : FAILING } });
  };

  const advance = (): void => {
    const callbacks: TWriteCallbacks = {
      onWritten: () => {
        commitFirst();
        advance();
      },
      onFailed: () => {
        failWrite();
        advance();
      },
      onInterrupted: () => {
        update({ changes: { busy: false } });
        advance();
      }
    };

    const actions = {
      wait: () => {
        // an operation is in flight or there is nothing to do
      },
      close: startClose,
      write: () => {
        update({ changes: { busy: true } });
        writeChunks({
          handle: state.handle!,
          chunks: state.queue[0],
          isWritable: () => {
            return WRITABLE.includes(state.status.type);
          },
          callbacks
        });
      }
    };

    actions[nextAction({ state })]();
  };

  const onOpened = ({ opened }: { opened: TFileSinkHandle }) => {
    update({ changes: { handle: opened, busy: false, status: state.status === OPENING ? OPEN : state.status } });
    advance();
  };

  const onOpenFailed = () => {
    update({ changes: { busy: false, status: state.status === DESTROYING ? DESTROYED : FAILED } });
  };

  const write = ({ chunks }: { chunks: readonly TBinaryStreamChunk[] }): TSinkStreamWriteTransaction => {
    const index = state.written;

    update({ changes: { written: index + 1, queue: [...state.queue, chunks] } });
    advance();

    return {
      status: () => {
        return transactionStatus({ index, state });
      }
    };
  };

  open(path, "w").then((opened) => {
    onOpened({ opened });
  }, onOpenFailed);

  return {
    status: () => {
      return state.status;
    },
    write,
    end: () => {
      update({ changes: { status: FINISHING } });
      advance();
    },
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: false });
    },
    destroy: () => {
      update({ changes: { status: DESTROYING } });
      advance();
    }
  };
};

export {
  createFileSink
};
