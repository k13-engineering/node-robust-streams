import type { TPollHandle, TPollHandleStatus } from "./poll.ts";
import type {
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";

type TStatus = {
  type: string;
};

type TTransition = readonly [string, string];

type TGuardSpec = {
  name: string;
  transitions: readonly TTransition[];
};

type TGuardContext<S extends TStatus> = {
  // observes the status of the guarded object, checks it and returns it deeply frozen
  observe: () => S;

  // checks that method may be called in the current status, then calls fn
  call: <R>(args: { method: string; forbidden: readonly string[]; fn: () => R }) => R;

  // true while a guarded method is being executed
  isInCall: () => boolean;
};

const POLL_HANDLE_TRANSITIONS: readonly TTransition[] = [
  ["pending", "triggered"],
  ["pending", "cancelled"]
];

const TRANSACTION_TRANSITIONS: readonly TTransition[] = [
  ["pending", "committed"],
  ["pending", "discarded"]
];

const violation = ({ message }: { message: string }): Error => {
  return Error(`contract violation: ${message}`);
};

const ignore = () => {
  // nothing to do
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

// compares plain data (primitives, arrays and plain objects) by value
const isEqual = ({ a, b }: { a: unknown; b: unknown }): boolean => {
  if (!isObject(a) || !isObject(b)) {
    return a === b;
  }

  const keys = Object.keys(a);

  return keys.length === Object.keys(b).length && keys.every((key) => {
    return isEqual({ a: a[key], b: b[key] });
  });
};

// freezes value and everything it references, array buffer views can not be frozen and are skipped
const deepFreeze = <V>({ value }: { value: V }): V => {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) {
    return value;
  }

  Object.values(value).forEach((inner) => {
    deepFreeze({ value: inner });
  });

  return Object.freeze(value) as V;
};

// several transitions may happen between two observations, so the new status only needs to be reachable
const isReachable = ({ transitions, from, to }: { transitions: readonly TTransition[]; from: string; to: string }): boolean => {
  let visited = [from];
  let frontier = [from];

  while (frontier.length > 0) {
    const current = frontier;

    frontier = transitions.filter(([source, target]) => {
      return current.includes(source) && !visited.includes(target);
    }).map(([, target]) => {
      return target;
    });

    visited = [...visited, ...frontier];
  }

  return visited.includes(to);
};

const createGuardContext = <S extends TStatus>({
  spec,
  status,
  onObserve
}: {
  spec: TGuardSpec;
  status: () => S;
  onObserve: (args: { status: S }) => void;
}): TGuardContext<S> => {
  const knownStatuses = spec.transitions.flat();
  let last: S | undefined = undefined;
  let depth = 0;

  const checkKnown = ({ next }: { next: S }) => {
    if (!knownStatuses.includes(next.type)) {
      throw violation({ message: `${spec.name}.status() MUST NOT yield the unknown status ${next.type}` });
    }
  };

  const checkTransition = ({ next }: { next: S }) => {
    if (last === undefined) {
      return;
    }

    if (!isReachable({ transitions: spec.transitions, from: last.type, to: next.type })) {
      throw violation({ message: `${spec.name}: status ${last.type} MUST NOT change to ${next.type}` });
    }
  };

  const observe = (): S => {
    const first = status();
    const second = status();

    if (!isEqual({ a: first, b: second })) {
      throw violation({ message: `${spec.name}.status() MUST yield the same result when called repeatedly` });
    }

    checkKnown({ next: first });
    checkTransition({ next: first });
    last = first;
    onObserve({ status: first });

    return deepFreeze({ value: first });
  };

  const call: TGuardContext<S>["call"] = ({ method, forbidden, fn }) => {
    const current = observe();

    if (forbidden.includes(current.type)) {
      throw violation({ message: `${spec.name}.${method}() MUST NOT be called in status ${current.type}` });
    }

    const invoke = () => {
      depth += 1;

      try {
        return fn();
      } finally {
        depth -= 1;
      }
    };

    const result = invoke();
    observe();

    return result;
  };

  return {
    observe,
    call,
    isInCall: () => {
      return depth > 0;
    }
  };
};

const guardMethod = <S extends TStatus>({
  ctx,
  method,
  forbidden,
  fn
}: {
  ctx: TGuardContext<S>;
  method: string;
  forbidden: readonly string[];
  fn: () => void;
}) => {
  return () => {
    ctx.call({ method, forbidden, fn });
  };
};

const guardRead = <S extends TStatus, R>({
  ctx,
  forbidden,
  read
}: {
  ctx: TGuardContext<S>;
  forbidden: readonly string[];
  read: () => R;
}) => {
  return (): R => {
    return deepFreeze({ value: ctx.call({ method: "read", forbidden, fn: read }) });
  };
};

const guardPollHandle = ({ name, handle }: { name: string; handle: TPollHandle }): TPollHandle => {
  const ctx = createGuardContext<TPollHandleStatus>({
    spec: { name: `${name} poll handle`, transitions: POLL_HANDLE_TRANSITIONS },
    status: handle.status,
    onObserve: ignore
  });

  if (ctx.observe().type !== "pending") {
    throw violation({ message: `${name}.poll() MUST return a pending poll handle` });
  }

  return {
    status: ctx.observe,
    cancel: guardMethod({ ctx, method: "cancel", forbidden: ["triggered", "cancelled"], fn: handle.cancel })
  };
};

const guardPoll = <S extends TStatus>({
  name,
  ctx,
  forbidden,
  poll
}: {
  name: string;
  ctx: TGuardContext<S>;
  forbidden: readonly string[];
  poll: (args: { onUpdate: () => void }) => TPollHandle;
}) => {
  return ({ onUpdate }: { onUpdate: () => void }): TPollHandle => {
    let handle: TPollHandle | undefined = undefined;

    const guardedOnUpdate = () => {
      if (ctx.isInCall()) {
        throw violation({ message: `${name}: onUpdate MUST NOT be called synchronously` });
      }

      if (handle!.status().type !== "triggered") {
        throw violation({ message: `${name}: the poll handle MUST already yield triggered when onUpdate is called` });
      }

      onUpdate();
    };

    const before = ctx.observe();

    handle = ctx.call({
      method: "poll",
      forbidden,
      fn: () => {
        return poll({ onUpdate: guardedOnUpdate });
      }
    });

    if (!isEqual({ a: before, b: ctx.observe() })) {
      throw violation({ message: `${name}.poll() MUST NOT change the status synchronously` });
    }

    return guardPollHandle({ name, handle });
  };
};

type TTransactionTracker<X extends TSinkStreamWriteTransactionStatus> = {
  track: (args: { transaction: TSinkStreamWriteTransaction<X> }) => TSinkStreamWriteTransaction<X>;
  checkStream: (args: { status: TStatus }) => void;
};

const createTransactionTracker = <X extends TSinkStreamWriteTransactionStatus>({
  name,
  completeStatus,
  finalStatuses,
  streamStatus
}: {
  name: string;
  completeStatus: string;
  finalStatuses: readonly string[];
  streamStatus: () => TStatus;
}): TTransactionTracker<X> => {
  const discardStatuses = ["failed", "destroyed"];
  let transactions: readonly TSinkStreamWriteTransaction<X>[] = [];

  const hasStatus = ({ type }: { type: string }) => {
    return (transaction: TSinkStreamWriteTransaction<X>) => {
      return transaction.status().type === type;
    };
  };

  const checkOrder = ({ index }: { index: number }) => {
    if (!transactions.slice(0, index).every(hasStatus({ type: "committed" }))) {
      throw violation({ message: `${name}: transactions MUST be committed in the order they were written` });
    }
  };

  const checkDiscard = () => {
    const type = streamStatus().type;

    if (!discardStatuses.includes(type)) {
      throw violation({ message: `${name}: a transaction MUST NOT be discarded in status ${type}` });
    }
  };

  const onTransactionObserved = ({ index, status }: { index: number; status: X }) => {
    if (status.type === "committed") {
      checkOrder({ index });
    }

    if (status.type === "discarded") {
      checkDiscard();
    }
  };

  const track: TTransactionTracker<X>["track"] = ({ transaction }) => {
    const index = transactions.length;
    transactions = [...transactions, transaction];

    const ctx = createGuardContext<X>({
      spec: { name: `${name} transaction`, transitions: TRANSACTION_TRANSITIONS },
      status: transaction.status,
      onObserve: ({ status }) => {
        onTransactionObserved({ index, status });
      }
    });

    ctx.observe();

    // own properties of the transaction object are kept, only status() is guarded
    return {
      ...transaction,
      status: ctx.observe
    };
  };

  const checkFinal = ({ status }: { status: TStatus }) => {
    if (!finalStatuses.includes(status.type)) {
      return;
    }

    if (transactions.some(hasStatus({ type: "pending" }))) {
      throw violation({ message: `${name}: transactions MUST NOT be pending in status ${status.type}` });
    }
  };

  const checkComplete = ({ status }: { status: TStatus }) => {
    if (status.type !== completeStatus) {
      return;
    }

    if (!transactions.every(hasStatus({ type: "committed" }))) {
      throw violation({ message: `${name}: ${completeStatus} MUST NOT be entered before all transactions have been committed` });
    }
  };

  return {
    track,
    checkStream: ({ status }) => {
      checkFinal({ status });
      checkComplete({ status });
    }
  };
};

const guardWrite = <S extends TStatus, T, X extends TSinkStreamWriteTransactionStatus>({
  name,
  ctx,
  forbidden,
  write,
  transactions
}: {
  name: string;
  ctx: TGuardContext<S>;
  forbidden: readonly string[];
  write: (args: { chunks: readonly T[] }) => TSinkStreamWriteTransaction<X>;
  transactions: TTransactionTracker<X>;
}) => {
  return ({ chunks }: { chunks: readonly T[] }): TSinkStreamWriteTransaction<X> => {
    if (chunks.length === 0) {
      throw violation({ message: `${name}.write() MUST NOT be called with an empty chunks array` });
    }

    const frozen = deepFreeze({ value: chunks });

    const transaction = ctx.call({
      method: "write",
      forbidden,
      fn: () => {
        return write({ chunks: frozen });
      }
    });

    return transactions.track({ transaction });
  };
};

export type {
  TGuardContext,
  TGuardSpec,
  TTransition
};

export {
  isEqual,
  createGuardContext,
  createTransactionTracker,
  deepFreeze,
  guardMethod,
  guardPoll,
  guardRead,
  guardWrite,
  ignore,
  violation
};
