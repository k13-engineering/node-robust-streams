// shared helpers and test doubles for the spec files, this file contains no tests itself

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createPollRegistry } from "./poll-registry.ts";
import type { TPollHandle, TPollHandleStatus } from "./poll.ts";
import type {
  TSinkStream,
  TSinkStreamStatus,
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";
import type { TSourceStream, TSourceStreamStatus } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";

type TPollable = {
  status: () => { type: string };
  poll: (args: { onUpdate: () => void }) => TPollHandle;
};

type TTextChunk = {
  text: string;
};

const PENDING: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "pending" });
const COMMITTED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "committed" });
const DISCARDED: TSinkStreamWriteTransactionStatus = Object.freeze({ type: "discarded" });

// resolves in a later task, after all microtasks and all zero delay timers that have been scheduled so far
const nextTask = (): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

const nextTasks = async ({ count }: { count: number }) => {
  for (let index = 0; index < count; index += 1) {
    await nextTask();
  }
};

// uses the poll mechanism of the stream itself to wait until it is in one of the given statuses
const untilStatus = ({ stream, types }: { stream: TPollable; types: readonly string[] }): Promise<void> => {
  return new Promise((resolve) => {
    const check = () => {
      if (types.includes(stream.status().type)) {
        resolve();
        return;
      }

      stream.poll({ onUpdate: check });
    };

    check();
  });
};

const pollHandle = ({ type }: { type: TPollHandleStatus["type"] }): TPollHandle => {
  return {
    status: () => {
      return { type };
    },
    cancel: () => {
      // nothing to cancel
    }
  };
};

const createControllableSource = <T extends TStreamChunk>({
  initial = "opening"
}: {
  initial?: TSourceStreamStatus["type"]
} = {}) => {
  const polls = createPollRegistry();
  let status: TSourceStreamStatus = Object.freeze({ type: initial });
  let buffered: readonly T[] = [];

  const set = ({ type }: { type: TSourceStreamStatus["type"] }) => {
    status = Object.freeze({ type });
    polls.notify();
  };

  const provide = ({ chunks }: { chunks: readonly T[] }) => {
    buffered = [...buffered, ...chunks];
    polls.notify();
  };

  const source: TSourceStream<T> = {
    status: () => {
      return status;
    },
    read: () => {
      const result = { chunks: buffered };
      buffered = [];
      return result;
    },
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: buffered.length > 0 });
    },
    destroy: () => {
      set({ type: "destroying" });
    }
  };

  return { source, set, provide };
};

const createControllableSink = <T extends TStreamChunk>({
  initial = "opening"
}: {
  initial?: TSinkStreamStatus["type"]
} = {}) => {
  const polls = createPollRegistry();
  let status: TSinkStreamStatus = Object.freeze({ type: initial });
  let writes: readonly (readonly T[])[] = [];
  let committed = 0;

  const set = ({ type }: { type: TSinkStreamStatus["type"] }) => {
    status = Object.freeze({ type });
    polls.notify();
  };

  const commit = ({ count }: { count: number }) => {
    committed += count;
    polls.notify();
  };

  const transactionStatus = ({ index }: { index: number }) => {
    if (index < committed) {
      return COMMITTED;
    }

    if (["failed", "destroyed"].includes(status.type)) {
      return DISCARDED;
    }

    return PENDING;
  };

  const sink: TSinkStream<T> = {
    status: () => {
      return status;
    },
    write: ({ chunks }): TSinkStreamWriteTransaction => {
      const index = writes.length;
      writes = [...writes, chunks];
      return {
        status: () => {
          return transactionStatus({ index });
        }
      };
    },
    end: () => {
      set({ type: "finishing" });
    },
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: false });
    },
    destroy: () => {
      set({ type: "destroying" });
    }
  };

  return {
    sink,
    set,
    commit,
    writes: () => {
      return writes;
    }
  };
};

// sink double committing every transaction in a later task, it finishes once ended and all are committed
const createAutoSink = <T extends TStreamChunk>() => {
  const controllable = createControllableSink<T>({ initial: "open" });
  let ended = false;
  let committed = 0;

  const settle = () => {
    const outstanding = controllable.writes().length - committed;

    committed += outstanding;
    controllable.commit({ count: outstanding });

    if (ended) {
      controllable.set({ type: "finished" });
    }
  };

  const sink: TSinkStream<T> = {
    ...controllable.sink,
    write: (args) => {
      const transaction = controllable.sink.write(args);
      setTimeout(settle, 0);
      return transaction;
    },
    end: () => {
      ended = true;
      controllable.sink.end();
      setTimeout(settle, 0);
    }
  };

  return { sink, writes: controllable.writes };
};

// its poll handles yield triggered one task before onUpdate is called, which the contract allows
const deferOnUpdate = <S extends TPollable>({ stream }: { stream: S }): S => {
  return {
    ...stream,
    poll: ({ onUpdate }: { onUpdate: () => void }): TPollHandle => {
      let triggered = false;

      const inner = stream.poll({
        onUpdate: () => {
          triggered = true;
          setTimeout(onUpdate, 0);
        }
      });

      return {
        status: () => {
          return triggered ? { type: "triggered" } : inner.status();
        },
        cancel: inner.cancel
      };
    }
  };
};

// runs the given module source in a separate node process, e.g. to observe an uncaught exception
const runModule = ({ source }: { source: string }) => {
  const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "robust-streams-"));
  const file = nodePath.join(directory, "module.mts");

  fs.writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  fs.rmSync(directory, { recursive: true });

  return result;
};

const moduleUrl = ({ file }: { file: string }) => {
  return new URL(file, import.meta.url).href;
};

const textChunks = ({ texts }: { texts: readonly string[] }): readonly TTextChunk[] => {
  return texts.map((text) => {
    return { text };
  });
};

export type {
  TTextChunk
};

export {
  createAutoSink,
  createControllableSink,
  deferOnUpdate,
  createControllableSource,
  moduleUrl,
  nextTask,
  nextTasks,
  pollHandle,
  runModule,
  textChunks,
  untilStatus
};
