import { createPollRegistry } from "./poll-registry.ts";
import type {
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";
import type { TSourceStreamReadResult } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";
import type { TDuplexStream, TDuplexStreamStatus } from "./duplex-stream.ts";

type TSyncDuplexResult<U extends TStreamChunk> = {
  error?: Error;
  chunks?: readonly U[];
};

// the statuses a sync duplex may yield
type TSyncDuplexStatus = Extract<TDuplexStreamStatus, { type: "open" | "flushing" | "done" | "failed" | "destroyed" }>;

const OPEN: TSyncDuplexStatus = Object.freeze({ type: "open" });
const FLUSHING: TSyncDuplexStatus = Object.freeze({ type: "flushing" });
const DONE: TSyncDuplexStatus = Object.freeze({ type: "done" });
const FAILED: TSyncDuplexStatus = Object.freeze({ type: "failed" });
const DESTROYED: TSyncDuplexStatus = Object.freeze({ type: "destroyed" });

const PENDING: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "pending" });
const COMMITTED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "committed" });
const DISCARDED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "discarded" });

const ACTIVE = ["open", "flushing"];
const DISCARDING = ["failed", "destroyed"];

const noChunks = <U extends TStreamChunk>(): TSyncDuplexResult<U> => {
  return { chunks: [] };
};

// duplex processing chunks synchronously within write()
//  - start is called before the first chunks are transformed, finish is called by end(), both may produce chunks
//  - a transaction is committed once all data resulting from its chunks has been read
//  - start, transform and finish MUST return error or chunks, an error fails the duplex, as statuses
//    do not carry error information yet, the error itself is not reported
//  - an exception thrown by start, transform or finish is a bug and is not caught
const syncDuplex = <T extends TStreamChunk, U extends TStreamChunk>({
  start = noChunks,
  transform,
  finish = noChunks
}: {
  start?: () => TSyncDuplexResult<U>;
  transform: (args: { chunks: readonly T[] }) => TSyncDuplexResult<U>;
  finish?: () => TSyncDuplexResult<U>;
}): TDuplexStream<T, U, TSyncDuplexStatus> => {
  const polls = createPollRegistry();
  let status: TSyncDuplexStatus = OPEN;
  let started = false;
  let buffered: readonly U[] = [];
  let written = 0;
  let committed = 0;

  const transactionStatus = ({ index }: { index: number }) => {
    if (index < committed) {
      return COMMITTED;
    }

    return DISCARDING.includes(status.type) ? DISCARDED : PENDING;
  };

  const process = ({ result }: { result: TSyncDuplexResult<U> }) => {
    if (result.error === undefined && result.chunks === undefined) {
      throw Error("sync duplex: start, transform and finish MUST return error or chunks");
    }

    if (result.error !== undefined) {
      status = FAILED;
      buffered = [];
      return;
    }

    buffered = [...buffered, ...result.chunks!];
  };

  const ensureStarted = () => {
    if (!started) {
      started = true;
      process({ result: start() });
    }
  };

  // once nothing is buffered anymore, all data resulting from the transactions written so far has been read
  const settleDrained = () => {
    if (buffered.length === 0) {
      committed = written;
    }

    if (status === FLUSHING && buffered.length === 0) {
      status = DONE;
    }
  };

  const settle = () => {
    if (ACTIVE.includes(status.type)) {
      settleDrained();
    }

    polls.notify();
  };

  const write = ({ chunks }: { chunks: readonly T[] }): TSinkStreamWriteTransaction => {
    const index = written;
    written += 1;

    ensureStarted();

    if (status === OPEN) {
      process({ result: transform({ chunks }) });
    }

    settle();

    return {
      status: () => {
        return transactionStatus({ index });
      }
    };
  };

  const read = (): TSourceStreamReadResult<U> => {
    const result = Object.freeze({ chunks: Object.freeze(buffered) });

    buffered = [];
    settle();

    return result;
  };

  const end = () => {
    ensureStarted();

    if (status === OPEN) {
      process({ result: finish() });
    }

    if (status === OPEN) {
      status = FLUSHING;
    }

    settle();
  };

  return {
    status: () => {
      return status;
    },
    read,
    write,
    end,
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: buffered.length > 0 });
    },
    destroy: () => {
      buffered = [];
      status = DESTROYED;
      polls.notify();
    }
  };
};

export type {
  TSyncDuplexResult,
  TSyncDuplexStatus
};

export {
  syncDuplex
};
