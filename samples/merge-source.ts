import { allIn, anyIn, whenAllFinal } from "./composite.ts";
import { createPollRegistry } from "../lib/poll-registry.ts";
import type {
  TSourceStream,
  TSourceStreamReadResult,
  TSourceStreamStatus
} from "../lib/source-stream.ts";
import type { TStreamChunk } from "../lib/stream-chunk.ts";

const OPENING: TSourceStreamStatus = Object.freeze({ type: "opening" });
const OPEN: TSourceStreamStatus = Object.freeze({ type: "open" });
const ENDING: TSourceStreamStatus = Object.freeze({ type: "ending" });
const ENDED: TSourceStreamStatus = Object.freeze({ type: "ended" });
const FAILING: TSourceStreamStatus = Object.freeze({ type: "failing" });
const FAILED: TSourceStreamStatus = Object.freeze({ type: "failed" });
const DESTROYING: TSourceStreamStatus = Object.freeze({ type: "destroying" });
const DESTROYED: TSourceStreamStatus = Object.freeze({ type: "destroyed" });

const FINAL = ["ended", "failed", "destroyed"];
const BROKEN = ["failing", "failed", "destroying", "destroyed"];
const HEALTHY = ["opening", "open", "ending"];
const EXHAUSTED = ["ending", "ended"];

const deriveProgress = ({ types, opened }: { types: readonly string[]; opened: boolean }) => {
  if (allIn({ types, allowed: ["ended"] })) {
    return ENDED;
  }

  if (allIn({ types, allowed: EXHAUSTED })) {
    return ENDING;
  }

  // once open, the merge source stays open until all children are exhausted, as open -> opening is not allowed
  return opened ? OPEN : OPENING;
};

const deriveStatus = ({
  types,
  opened,
  destroyRequested
}: {
  types: readonly string[];
  opened: boolean;
  destroyRequested: boolean;
}): TSourceStreamStatus => {
  if (destroyRequested) {
    return whenAllFinal<TSourceStreamStatus>({ types, finalTypes: FINAL, final: DESTROYED, busy: DESTROYING });
  }

  if (anyIn({ types, allowed: BROKEN })) {
    return whenAllFinal<TSourceStreamStatus>({ types, finalTypes: FINAL, final: FAILED, busy: FAILING });
  }

  return deriveProgress({ types, opened });
};

const childTypesOf = <T extends TStreamChunk>({ sources }: { sources: readonly TSourceStream<T>[] }) => {
  return sources.map((source) => {
    return source.status().type;
  });
};

const destroyHealthyChildren = <T extends TStreamChunk>({ sources }: { sources: readonly TSourceStream<T>[] }) => {
  sources.filter((source) => {
    return HEALTHY.includes(source.status().type);
  }).forEach((source) => {
    source.destroy();
  });
};

// source reading from all of its child sources, read() returns the chunks of all open children
//  - the merge source owns its children: once a child breaks (fails or is destroyed), all others are destroyed
//  - it ends once all children have ended
//  - final statuses are only entered once all children are final
const createMergeSource = <T extends TStreamChunk>({ sources }: { sources: readonly TSourceStream<T>[] }): TSourceStream<T> => {
  const polls = createPollRegistry();
  let status: TSourceStreamStatus = OPENING;
  let opened = false;
  let destroyRequested = false;
  let maybeData = false;

  const tearingDown = () => {
    return destroyRequested || anyIn({ types: childTypesOf({ sources }), allowed: BROKEN });
  };

  const refresh = () => {
    if (tearingDown()) {
      destroyHealthyChildren({ sources });
    }

    opened = opened || childTypesOf({ sources }).includes("open");
    status = deriveStatus({ types: childTypesOf({ sources }), opened, destroyRequested });
    polls.notify();
  };

  // children that fired while open might still have data to read, polling them again right away would trigger
  // again and again, so they are parked until the next read(), while tearing down, all children are watched
  let parked: readonly TSourceStream<T>[] = [];

  const takeParked = () => {
    const taken = parked;
    parked = [];
    return taken;
  };

  const shouldPark = ({ source }: { source: TSourceStream<T> }) => {
    return source.status().type === "open" && !tearingDown();
  };

  // a child poll fires when the child changed its status or has data, so there might be data to read
  const watch = ({ children }: { children: readonly TSourceStream<T>[] }): void => {
    children.filter((source) => {
      return !FINAL.includes(source.status().type);
    }).forEach((source) => {
      source.poll({
        onUpdate: () => {
          maybeData = true;
          refresh();

          if (shouldPark({ source })) {
            parked = [...parked, source];
            return;
          }

          watch({ children: [source, ...(tearingDown() ? takeParked() : [])] });
        }
      });
    });
  };

  const read = (): TSourceStreamReadResult<T> => {
    const chunks = sources.filter((source) => {
      return source.status().type === "open";
    }).flatMap((source) => {
      return source.read().chunks;
    });

    maybeData = false;
    refresh();
    watch({ children: takeParked() });

    return Object.freeze({ chunks: Object.freeze(chunks) });
  };

  refresh();
  watch({ children: sources });

  return {
    status: () => {
      return status;
    },
    read,
    poll: ({ onUpdate }) => {
      return polls.poll({ onUpdate, ready: maybeData });
    },
    destroy: () => {
      destroyRequested = true;
      refresh();
      watch({ children: takeParked() });
    }
  };
};

export {
  createMergeSource
};
