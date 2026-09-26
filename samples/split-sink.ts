import { allIn, anyIn, whenAllFinal } from "./composite.ts";
import { createPollRegistry } from "../lib/poll-registry.ts";
import type {
  TSinkStream,
  TSinkStreamStatus,
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "../lib/sink-stream.ts";
import type { TStreamChunk } from "../lib/stream-chunk.ts";

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

const FINAL = ["finished", "failed", "destroyed"];
const BROKEN = ["failing", "failed", "destroying", "destroyed"];
const HEALTHY = ["opening", "open", "finishing"];
const DISCARDING: readonly TSinkStreamStatus[] = [FAILED, DESTROYED];

const deriveProgress = ({ types, ended }: { types: readonly string[]; ended: boolean }) => {
  if (ended) {
    return allIn({ types, allowed: ["finished"] }) ? FINISHED : FINISHING;
  }

  return allIn({ types, allowed: ["open"] }) ? OPEN : OPENING;
};

const deriveStatus = ({
  types,
  ended,
  destroyRequested
}: {
  types: readonly string[];
  ended: boolean;
  destroyRequested: boolean;
}): TSinkStreamStatus => {
  if (destroyRequested) {
    return whenAllFinal<TSinkStreamStatus>({ types, finalTypes: FINAL, final: DESTROYED, busy: DESTROYING });
  }

  if (anyIn({ types, allowed: BROKEN })) {
    return whenAllFinal<TSinkStreamStatus>({ types, finalTypes: FINAL, final: FAILED, busy: FAILING });
  }

  return deriveProgress({ types, ended });
};

// sink writing every chunk to all of its child sinks, the chunks are shared, as they are immutable
//  - the split sink owns its children: once a child breaks (fails or is destroyed), all others are destroyed
//  - a transaction is committed once it has been committed by all children
//  - final statuses are only entered once all children are final
const createSplitSink = <T extends TStreamChunk>({ sinks }: { sinks: readonly TSinkStream<T>[] }): TSinkStream<T> => {
  const polls = createPollRegistry();
  let status: TSinkStreamStatus = OPENING;
  let ended = false;
  let destroyRequested = false;

  const childTypes = () => {
    return sinks.map((sink) => {
      return sink.status().type;
    });
  };

  const destroyHealthyChildren = () => {
    sinks.filter((sink) => {
      return HEALTHY.includes(sink.status().type);
    }).forEach((sink) => {
      sink.destroy();
    });
  };

  const refresh = () => {
    if (destroyRequested || anyIn({ types: childTypes(), allowed: BROKEN })) {
      destroyHealthyChildren();
    }

    status = deriveStatus({ types: childTypes(), ended, destroyRequested });
    polls.notify();
  };

  const watch = ({ sink }: { sink: TSinkStream<T> }) => {
    if (FINAL.includes(sink.status().type)) {
      return;
    }

    sink.poll({
      onUpdate: () => {
        refresh();
        watch({ sink });
      }
    });
  };

  const transactionStatus = ({ children }: { children: readonly TSinkStreamWriteTransaction[] }) => {
    if (children.every((child) => {
      return child.status().type === "committed";
    })) {
      return COMMITTED;
    }

    if (DISCARDING.includes(status)) {
      return DISCARDED;
    }

    return PENDING;
  };

  const write = ({ chunks }: { chunks: readonly T[] }): TSinkStreamWriteTransaction => {
    const children = sinks.map((sink) => {
      return sink.write({ chunks });
    });

    return {
      status: () => {
        return transactionStatus({ children });
      }
    };
  };

  refresh();
  sinks.forEach((sink) => {
    watch({ sink });
  });

  return {
    status: () => {
      return status;
    },
    write,
    end: () => {
      ended = true;
      sinks.forEach((sink) => {
        sink.end();
      });
      refresh();
    },
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: false });
    },
    destroy: () => {
      destroyRequested = true;
      refresh();
    }
  };
};

export {
  createSplitSink
};
