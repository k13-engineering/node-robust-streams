import { createPollRegistry } from "./poll-registry.ts";
import type { TSourceStream, TSourceStreamReadResult } from "./source-stream.ts";
import { statusOf } from "./status-report.ts";
import type { TNoProperties, TStatusReport } from "./status-report.ts";
import type { TStreamChunk } from "./stream-chunk.ts";

type TSyncSourceReadArgs = {
  hints: {
    amount: number;
  }
};

// own properties the functions of a sync source report, they MUST NOT use the names of the properties the sync source sets itself
type TSyncSourceStatusProperties = object & { type?: never };

// reports the status properties of the source while open, until the first read
type TSyncSourceOpenResult<SP extends TSyncSourceStatusProperties = TNoProperties> = {
  error: Error;
} | ({
  error: undefined;
} & TStatusReport<SP>);

// reports the status properties of the source while open together with chunks
type TSyncSourceReadResult<T extends TStreamChunk, SP extends TSyncSourceStatusProperties = TNoProperties> = {
  error: Error;
  chunks: undefined;
  end: undefined;
} | ({
  error: undefined;
  chunks: readonly T[];
  end: false;
} & TStatusReport<SP>) | {
  error: undefined;
  chunks: undefined;
  end: true;
};

// reports the status properties of the source once destroyed
type TSyncSourceDestroyResult<DP extends TSyncSourceStatusProperties = TNoProperties> = TStatusReport<DP>;

// the statuses a sync source may yield, as open, read and destroy are synchronous, it never is observably
// opening, ending, failing or destroying
//  - open carries the status properties reported by open, replaced by the ones reported by every read
//  - destroyed carries the status properties reported by destroy
type TSyncSourceStatus<
  SP extends TSyncSourceStatusProperties = TNoProperties,
  DP extends TSyncSourceStatusProperties = TNoProperties
> = ({
  type: "open";
} & SP) | {
  type: "ended";
} | {
  type: "failed";
} | ({
  type: "destroyed";
} & DP);

// open is required as soon as the status properties are non-empty, as it reports their initial value
type TSyncSourceOpenOption<SP extends TSyncSourceStatusProperties> = [keyof SP] extends [never] ? {
  open?: () => TSyncSourceOpenResult<SP>;
} : {
  open: () => TSyncSourceOpenResult<SP>;
};

// destroy is required as soon as the status properties of destroyed are non-empty, as it reports them
type TSyncSourceDestroyOption<DP extends TSyncSourceStatusProperties> = [keyof DP] extends [never] ? {
  destroy?: () => TSyncSourceDestroyResult<DP>;
} : {
  destroy: () => TSyncSourceDestroyResult<DP>;
};

type TSyncSourceOptions<
  T extends TStreamChunk,
  SP extends TSyncSourceStatusProperties,
  DP extends TSyncSourceStatusProperties
> = TSyncSourceOpenOption<SP> & TSyncSourceDestroyOption<DP> & {
  read: (args: TSyncSourceReadArgs) => TSyncSourceReadResult<T, SP>;
};

type TSyncSource<
  T extends TStreamChunk,
  SP extends TSyncSourceStatusProperties = TNoProperties,
  DP extends TSyncSourceStatusProperties = TNoProperties
> = TSourceStream<T, TSyncSourceStatus<SP, DP>>;

const ENDED = Object.freeze({ type: "ended" as const });
const FAILED = Object.freeze({ type: "failed" as const });

const READ_ARGS: TSyncSourceReadArgs = Object.freeze({ hints: Object.freeze({ amount: 16384 }) });

const openWithoutStatus = () => {
  return { error: undefined };
};

const nothingToDestroy = () => {
  // the read function holds no resources
  return {};
};

const statusWith = <K extends "open" | "destroyed", P extends TSyncSourceStatusProperties>({
  type,
  properties
}: {
  type: K;
  properties: P
}) => {
  return Object.freeze({ ...properties, type });
};

// the status of the source after the read function returned the given result
const statusAfter = <
  T extends TStreamChunk,
  SP extends TSyncSourceStatusProperties,
  DP extends TSyncSourceStatusProperties
>({ result }: { result: TSyncSourceReadResult<T, SP> }): TSyncSourceStatus<SP, DP> => {
  if (result.error !== undefined) {
    return FAILED;
  }

  if (result.end) {
    return ENDED;
  }

  return statusWith({ type: "open", properties: statusOf<SP>({ report: result }) });
};

// source pulling chunks from a synchronous read function
//  - open is called right away when the source is created, an error returned by it fails the source right away
//  - the read function acts like a kernel buffer: its data stays in it until read() is called,
//    so every read() calls it once and hands out what it returned
//  - as the read function is synchronous, there is always something to read while open, so polls are triggered right away,
//    therefore the read function SHOULD NOT return empty chunks, a consumer would poll and read again right away
//  - open, read and destroy MAY report own properties for the status of the source, open and read report
//    the ones of open together, read reports them together with chunks
//  - an error returned by open or the read function fails the source, as statuses do not carry error information yet,
//    the error itself is not reported
const syncSource = <
  T extends TStreamChunk,
  SP extends TSyncSourceStatusProperties = TNoProperties,
  DP extends TSyncSourceStatusProperties = TNoProperties
>(options: TSyncSourceOptions<T, SP, DP>): TSyncSource<T, SP, DP> => {
  const { open: providedOpen = openWithoutStatus, read: providedRead, destroy: providedDestroy = nothingToDestroy } = options;
  const polls = createPollRegistry();
  const opened: TSyncSourceOpenResult<SP> = providedOpen();
  let status: TSyncSourceStatus<SP, DP> = opened.error === undefined
    ? statusWith({ type: "open", properties: statusOf<SP>({ report: opened }) })
    : FAILED;

  const transition = ({ to }: { to: TSyncSourceStatus<SP, DP> }) => {
    status = to;
    polls.notify();
  };

  const read = (): TSourceStreamReadResult<T> => {
    const result = providedRead(READ_ARGS);
    transition({ to: statusAfter<T, SP, DP>({ result }) });

    return Object.freeze({ chunks: Object.freeze([...(result.chunks ?? [])]) });
  };

  return {
    status: () => {
      return status;
    },
    read,
    poll: ({ onUpdate }) => {
      // within the implementation, typescript resolves type of the open status to never, as SP forbids an own type
      const { type }: { type: string } = status;
      return polls.poll({ onUpdate, ready: type === "open" });
    },
    destroy: () => {
      const destroyedProperties = statusOf<DP>({ report: providedDestroy() });
      transition({ to: statusWith({ type: "destroyed", properties: destroyedProperties }) });
    }
  };
};

export type {
  TSyncSource,
  TSyncSourceDestroyOption,
  TSyncSourceDestroyResult,
  TSyncSourceOpenOption,
  TSyncSourceOpenResult,
  TSyncSourceOptions,
  TSyncSourceReadArgs,
  TSyncSourceReadResult,
  TSyncSourceStatus,
  TSyncSourceStatusProperties
};

export {
  syncSource
};
