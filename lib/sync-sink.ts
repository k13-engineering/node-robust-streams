import { createPollRegistry } from "./poll-registry.ts";
import type { TSinkStream, TSinkStreamWriteTransaction } from "./sink-stream.ts";
import { statusOf } from "./status-report.ts";
import type { TNoProperties, TStatusReport } from "./status-report.ts";
import type { TStreamChunk } from "./stream-chunk.ts";

// own properties the functions of a sync sink report, they MUST NOT use the names of the properties the sync sink sets itself
type TSyncSinkStatusProperties = object & { type?: never; chunksWritten?: never };
type TSyncSinkTransactionProperties = object & { type?: never };

// like a status report, a transaction report is required as soon as its properties are non-empty
type TTransactionReport<P extends object> = [keyof P] extends [never] ? { transaction?: P | undefined } : { transaction: NoInfer<P> };

// reports the status properties of the sink while open, until the first write
type TSyncSinkOpenResult<SP extends TSyncSinkStatusProperties = TNoProperties> = {
  error: Error;
} | ({
  error: undefined;
} & TStatusReport<SP>);

type TSyncSinkWriteResult<
  SP extends TSyncSinkStatusProperties = TNoProperties,
  TP extends TSyncSinkTransactionProperties = TNoProperties
> = {
  error: Error;
} | ({
  error: undefined;
} & TStatusReport<SP> & TTransactionReport<TP>);

// reports the status properties of the sink once finished
type TSyncSinkFinishResult<FP extends TSyncSinkStatusProperties = TNoProperties> = {
  error: Error;
} | ({
  error: undefined;
} & TStatusReport<FP>);

// reports the status properties of the sink once destroyed
type TSyncSinkDestroyResult<DP extends TSyncSinkStatusProperties = TNoProperties> = TStatusReport<DP>;

// the statuses a sync sink may yield, as open, finish and destroy are synchronous, it never is observably
// opening, finishing or destroying
//  - chunksWritten is the number of chunks that have been written successfully
//  - open carries the status properties reported by open, replaced by the ones reported by every write
//  - finished and destroyed carry the status properties reported by finish and destroy
type TSyncSinkStatus<
  SP extends TSyncSinkStatusProperties = TNoProperties,
  FP extends TSyncSinkStatusProperties = TNoProperties,
  DP extends TSyncSinkStatusProperties = TNoProperties
> = ({
  type: "open";
  chunksWritten: number;
} & SP) | ({
  type: "finished";
  chunksWritten: number;
} & FP) | {
  type: "failed";
} | ({
  type: "destroyed";
  chunksWritten: number;
} & DP);

// write is synchronous, so a transaction is committed right away or discarded as the sink failed, it is never pending
// once committed, it carries the transaction properties reported by its write
type TSyncSinkTransactionStatus<TP extends TSyncSinkTransactionProperties = TNoProperties> = ({
  type: "committed";
} & TP) | {
  type: "discarded";
};

// open is required as soon as the status properties are non-empty, as it reports their initial value
type TSyncSinkOpenOption<SP extends TSyncSinkStatusProperties> = [keyof SP] extends [never] ? {
  open?: () => TSyncSinkOpenResult<SP>;
} : {
  open: () => TSyncSinkOpenResult<SP>;
};

type TSyncSinkOptions<
  T extends TStreamChunk,
  SP extends TSyncSinkStatusProperties,
  TP extends TSyncSinkTransactionProperties,
  FP extends TSyncSinkStatusProperties,
  DP extends TSyncSinkStatusProperties
> = TSyncSinkOpenOption<SP> & {
  write: (args: { chunks: readonly T[] }) => TSyncSinkWriteResult<SP, TP>;
  finish: () => TSyncSinkFinishResult<FP>;
  destroy: () => TSyncSinkDestroyResult<DP>;
};

type TSyncSink<
  T extends TStreamChunk,
  SP extends TSyncSinkStatusProperties = TNoProperties,
  TP extends TSyncSinkTransactionProperties = TNoProperties,
  FP extends TSyncSinkStatusProperties = TNoProperties,
  DP extends TSyncSinkStatusProperties = TNoProperties
> = TSinkStream<T, TSyncSinkStatus<SP, FP, DP>, TSyncSinkTransactionStatus<TP>>;

const FAILED = Object.freeze({ type: "failed" as const });
const DISCARDED = Object.freeze({ type: "discarded" as const });

const openWithoutStatus = () => {
  return { error: undefined };
};

// the report types require a report whenever its properties are non-empty, so {} only stands in for no properties
const transactionOf = <P extends object>({ report }: { report: { transaction?: P } }): P => {
  return report.transaction ?? ({} as P);
};

const statusWith = <K extends "open" | "finished" | "destroyed", P extends TSyncSinkStatusProperties>({
  type,
  chunksWritten,
  properties
}: {
  type: K;
  chunksWritten: number;
  properties: P
}) => {
  return Object.freeze({ ...properties, type, chunksWritten });
};

const committedStatus = <TP extends TSyncSinkTransactionProperties>({ properties }: { properties: TP }): TSyncSinkTransactionStatus<TP> => {
  return Object.freeze({ ...properties, type: "committed" as const });
};

// sink handing chunks to synchronous functions
//  - open is called right away when the sink is created, an error returned by it fails the sink right away
//  - a transaction is committed once write returned without error, so write MUST only return once the chunks
//    have been accepted in a way that an application crash can no longer lose them
//  - end() calls finish, the sink is finished once finish returned without error
//  - open, write, finish and destroy MAY report own properties for the status of the sink, open and write
//    report the ones of open together, write MAY also report own properties for the status of the transaction
//  - an error returned by open, write or finish fails the sink, as statuses do not carry error information yet,
//    the error itself is not reported
const syncSink = <
  T extends TStreamChunk,
  SP extends TSyncSinkStatusProperties = TNoProperties,
  TP extends TSyncSinkTransactionProperties = TNoProperties,
  FP extends TSyncSinkStatusProperties = TNoProperties,
  DP extends TSyncSinkStatusProperties = TNoProperties
>(options: TSyncSinkOptions<T, SP, TP, FP, DP>): TSyncSink<T, SP, TP, FP, DP> => {
  const { open: providedOpen = openWithoutStatus, write: providedWrite, finish: providedFinish, destroy: providedDestroy } = options;
  const polls = createPollRegistry();
  const opened: TSyncSinkOpenResult<SP> = providedOpen();
  let chunksWritten = 0;
  let properties = statusOf<SP>({ report: opened.error === undefined ? opened : {} });
  let status: TSyncSinkStatus<SP, FP, DP> = opened.error === undefined ? statusWith({ type: "open", chunksWritten, properties }) : FAILED;

  const transition = ({ to }: { to: TSyncSinkStatus<SP, FP, DP> }) => {
    status = to;
    polls.notify();
  };

  const commit = ({ chunks, result }: { chunks: readonly T[]; result: { status?: SP; transaction?: TP } }) => {
    chunksWritten += chunks.length;
    properties = statusOf<SP>({ report: result });
    transition({ to: statusWith({ type: "open", chunksWritten, properties }) });

    return committedStatus<TP>({ properties: transactionOf<TP>({ report: result }) });
  };

  const fail = () => {
    transition({ to: FAILED });
    return DISCARDED;
  };

  const write = ({ chunks }: { chunks: readonly T[] }): TSinkStreamWriteTransaction<TSyncSinkTransactionStatus<TP>> => {
    const result = providedWrite({ chunks });
    const transactionStatus = result.error === undefined ? commit({ chunks, result }) : fail();

    return {
      status: () => {
        return transactionStatus;
      }
    };
  };

  const end = () => {
    const result = providedFinish();

    transition({
      to: result.error === undefined
        ? statusWith({ type: "finished", chunksWritten, properties: statusOf<FP>({ report: result }) })
        : FAILED
    });
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
      const destroyedProperties = statusOf<DP>({ report: providedDestroy() });
      transition({ to: statusWith({ type: "destroyed", chunksWritten, properties: destroyedProperties }) });
    }
  };
};

export type {
  TSyncSink,
  TSyncSinkOptions,
  TSyncSinkOpenOption,
  TSyncSinkOpenResult,
  TSyncSinkWriteResult,
  TSyncSinkFinishResult,
  TSyncSinkDestroyResult,
  TSyncSinkStatus,
  TSyncSinkStatusProperties,
  TSyncSinkTransactionProperties,
  TSyncSinkTransactionStatus
};

export {
  syncSink
};
