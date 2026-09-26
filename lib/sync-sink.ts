import { createPollRegistry } from "./poll-registry.ts";
import type {
  TSinkStream,
  TSinkStreamStatus,
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";

type TSyncSinkWriteResult = {
  error: Error;
} | {
  error: undefined;
};

type TSyncSinkFinishResult = {
  error: Error;
} | {
  error: undefined;
};

const OPEN: TSinkStreamStatus = Object.freeze({ type: "open" });
const FINISHING: TSinkStreamStatus = Object.freeze({ type: "finishing" });
const FINISHED: TSinkStreamStatus = Object.freeze({ type: "finished" });
const FAILED: TSinkStreamStatus = Object.freeze({ type: "failed" });
const DESTROYED: TSinkStreamStatus = Object.freeze({ type: "destroyed" });

const COMMITTED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "committed" });
const DISCARDED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "discarded" });

// sink handing chunks to synchronous functions
//  - a transaction is committed once write returned without error, so write MUST only return once the chunks
//    have been accepted in a way that an application crash can no longer lose them
//  - end() calls finish, the sink is finished once finish returned without error
//  - an error returned by write or finish fails the sink, as statuses do not carry error information yet,
//    the error itself is not reported
const syncSink = <T extends TStreamChunk>({
  write: providedWrite,
  finish: providedFinish,
  destroy: providedDestroy
}: {
  write: (args: { chunks: readonly T[] }) => TSyncSinkWriteResult;
  finish: () => TSyncSinkFinishResult;
  destroy: () => void;
}): TSinkStream<T> => {
  const polls = createPollRegistry();
  let status: TSinkStreamStatus = OPEN;
  let written = 0;
  let committed = 0;

  const transition = ({ to }: { to: TSinkStreamStatus }) => {
    status = to;
    polls.notify();
  };

  // write is synchronous, so a transaction is either committed right away or discarded as the sink failed
  const transactionStatus = ({ index }: { index: number }) => {
    return index < committed ? COMMITTED : DISCARDED;
  };

  const write = ({ chunks }: { chunks: readonly T[] }): TSinkStreamWriteTransaction => {
    const index = written;
    written += 1;

    const { error } = providedWrite({ chunks });

    if (error === undefined) {
      committed += 1;
      polls.notify();
    } else {
      transition({ to: FAILED });
    }

    return {
      status: () => {
        return transactionStatus({ index });
      }
    };
  };

  const end = () => {
    transition({ to: FINISHING });

    const { error } = providedFinish();
    transition({ to: error === undefined ? FINISHED : FAILED });
  };

  return {
    status: () => {
      return status;
    },
    write,
    end,
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: false });
    },
    destroy: () => {
      providedDestroy();
      transition({ to: DESTROYED });
    }
  };
};

export type {
  TSyncSinkWriteResult,
  TSyncSinkFinishResult
};

export {
  syncSink
};
