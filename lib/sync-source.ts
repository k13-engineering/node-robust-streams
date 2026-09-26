import { createPollRegistry } from "./poll-registry.ts";
import type {
  TSourceStream,
  TSourceStreamReadResult,
  TSourceStreamStatus
} from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";

type TSyncSourceReadArgs = {
  hints: {
    amount: number;
  }
};

type TSyncSourceReadResult<T extends TStreamChunk> = {
  error: Error;
  chunks: undefined;
  end: undefined;
} | {
  error: undefined;
  chunks: readonly T[];
  end: false;
} | {
  error: undefined;
  chunks: undefined;
  end: true;
};

const OPEN: TSourceStreamStatus = Object.freeze({ type: "open" });
const ENDED: TSourceStreamStatus = Object.freeze({ type: "ended" });
const FAILED: TSourceStreamStatus = Object.freeze({ type: "failed" });
const DESTROYED: TSourceStreamStatus = Object.freeze({ type: "destroyed" });

const READ_ARGS: TSyncSourceReadArgs = Object.freeze({ hints: Object.freeze({ amount: 16384 }) });

const nothingToDestroy = () => {
  // the read function holds no resources
};

// source pulling chunks from a synchronous read function
//  - the read function acts like a kernel buffer: its data stays in it until read() is called,
//    so every read() calls it once and hands out what it returned
//  - as the read function is synchronous, there is always something to read while open, so polls are triggered right away,
//    therefore the read function SHOULD NOT return empty chunks, a consumer would poll and read again right away
//  - an error returned by the read function fails the source, as statuses do not carry error information yet,
//    the error itself is not reported
const syncSource = <T extends TStreamChunk>({
  read: providedRead,
  destroy: providedDestroy = nothingToDestroy
}: {
  read: (args: TSyncSourceReadArgs) => TSyncSourceReadResult<T>;
  destroy?: () => void;
}): TSourceStream<T> => {
  const polls = createPollRegistry();
  let status: TSourceStreamStatus = OPEN;

  const transition = ({ to }: { to: TSourceStreamStatus }) => {
    status = to;
    polls.notify();
  };

  const handOut = ({ chunks }: { chunks: readonly T[] }): TSourceStreamReadResult<T> => {
    return Object.freeze({ chunks: Object.freeze([...chunks]) });
  };

  const read = (): TSourceStreamReadResult<T> => {
    const result = providedRead(READ_ARGS);

    if (result.error !== undefined) {
      transition({ to: FAILED });
      return handOut({ chunks: [] });
    }

    if (result.end) {
      transition({ to: ENDED });
      return handOut({ chunks: [] });
    }

    return handOut({ chunks: result.chunks });
  };

  return {
    status: () => {
      return status;
    },
    read,
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: status === OPEN });
    },
    destroy: () => {
      providedDestroy();
      transition({ to: DESTROYED });
    }
  };
};

export type {
  TSyncSourceReadArgs,
  TSyncSourceReadResult
};

export {
  syncSource
};
