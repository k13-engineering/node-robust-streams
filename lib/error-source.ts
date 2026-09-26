import { violation } from "./guard.ts";
import type { TSourceStream, TSourceStreamStatus } from "./source-stream.ts";
import type { TStreamChunk } from "./stream-chunk.ts";

// the only status an error source yields
type TErrorSourceStatus = Extract<TSourceStreamStatus, { type: "failed" }>;

const FAILED: TErrorSourceStatus = Object.freeze({ type: "failed" });

const calledInFailed = ({ method }: { method: string }) => {
  return () => {
    throw violation({ message: `errorSource.${method}() MUST NOT be called in status failed` });
  };
};

// source that is failed right away, e.g. to test error handling
// as statuses do not carry error information yet, it takes no error
const errorSource = <T extends TStreamChunk>(): TSourceStream<T, TErrorSourceStatus> => {
  return {
    status: () => {
      return FAILED;
    },
    read: calledInFailed({ method: "read" }),
    poll: calledInFailed({ method: "poll" }),
    destroy: calledInFailed({ method: "destroy" })
  };
};

export type {
  TErrorSourceStatus
};

export {
  errorSource
};
