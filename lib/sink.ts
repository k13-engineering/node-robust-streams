/* eslint-disable complexity */
/* eslint-disable max-statements */

import type {
  TStreamChunk,
  TStreamBackpressureFunc,
  TStreamFailFunc,
  TStreamDestroyFunc
} from "./stream.ts";
import { ELogLevel } from "./debug.ts";
import type { ILogger, TELogLevel } from "./debug.ts";
import {
  StreamAlreadyDestroyedError,
  StreamAlreadyFailedError,
  StreamAlreadyFinishedError,
  StreamAlreadyFinishingError,
  StreamReentrancyError,
} from "./errors.ts";

type TSinkStream<T extends TStreamChunk> = {
  destroy: TStreamDestroyFunc;
  write: ({ chunks }: { chunks: T[] }) => undefined;
  finish: ({ done }: { done: () => void }) => undefined;
};

type TSinkStreamFactoryOptions = {
  backpressure: TStreamBackpressureFunc;
  fail: TStreamFailFunc;
};

type TSinkStreamFactory<T extends TStreamChunk> = {
  openSinkStream: (options: TSinkStreamFactoryOptions) => TSinkStream<T>;
};

type TDebuggableSinkStreamFactory<T extends TStreamChunk> = TSinkStreamFactory<T> & {
  debug: (args: { log: (args: { message: string }) => undefined }) => TSinkStreamFactory<T>;
};

const sink = <T extends TStreamChunk>({ openSinkStream: providedOpen }: TSinkStreamFactory<T>): TDebuggableSinkStreamFactory<T> => {
  let opened = false;
  let finishing = false;
  let finished = false;
  let destroyed = false;
  let failed = false;

  let logger: ILogger | undefined = undefined;
  const log = ({ level, message }: { level: TELogLevel, message: string }) => {
    if (logger) {
      logger.log({ level, message });
    }
  };

  const throwWithMessage = ({ message }: { message: string }) => {
    log({ level: ELogLevel.ERROR, message });
    throw Error(message);
  };

  let writeEntered = false;
  let backpressureEntered = false;

  type C = TDebuggableSinkStreamFactory<T>;
  type A = TSinkStreamFactoryOptions;

  const openSinkStream: C["openSinkStream"] = ({ backpressure: providedBackpressure, fail: providedFail }) => {

    if (opened) {
      throw Error(`cannot open a stream that is already open`);
    }

    const fail: A["fail"] = ({ error }) => {
      if (failed) {
        throw StreamAlreadyFailedError({ message: `fail: cannot fail a stream that is already failed` });
      }

      if (destroyed) {
        throw StreamAlreadyDestroyedError({ message: `fail: cannot fail a stream that is already destroyed` });
      }

      if (finished) {
        throw StreamAlreadyFinishedError({ message: `fail: cannot fail a stream that is already finished` });
      }

      log({ level: ELogLevel.INFO, message: `fail with error: ${error.message}` });

      failed = true;
      providedFail({ error });
    };

    const backpressure: A["backpressure"] = ({ pressure }) => {

      if (pressure < 0 || pressure > 1) {
        throw Error(`backpressure: pressure must be between 0 and 1`);
      }

      if (failed) {
        throw StreamAlreadyFailedError({ message: `backpressure: cannot backpressure a stream that is already failed` });
      }

      if (destroyed) {
        throw StreamAlreadyDestroyedError({ message: `backpressure: cannot backpressure a stream that is already destroyed` });
      }

      if (finishing) {
        throw StreamAlreadyFinishingError({ message: `backpressure: cannot backpressure a stream that is finishing` });
      }

      if (finished) {
        throw StreamAlreadyFinishedError({ message: `backpressure: cannot backpressure a stream that is already finished` });
      }

      log({ level: ELogLevel.INFO, message: `backpressure` });

      if (backpressureEntered) {
        throw StreamReentrancyError({ message: `backpressure: reentrancy detected` });
      }

      backpressureEntered = true;

      try {
        providedBackpressure({ pressure });
      } finally {
        backpressureEntered = false;
      }
    };

    log({ level: ELogLevel.INFO, message: `open` });
    const { write, finish, destroy } = providedOpen({ backpressure, fail });
    opened = true;

    return {
      write: ({ chunks }) => {
        if (failed) {
          throw StreamAlreadyFailedError({ message: `write: cannot write to a failed stream` });
        }

        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `write: cannot write to a destroyed stream` });
        }

        if (finishing) {
          throw StreamAlreadyFinishingError({ message: `write: cannot write to a stream that is finishing` });
        }

        if (finished) {
          throw StreamAlreadyFinishedError({ message: `write: cannot write to a finished stream` });
        }

        log({ level: ELogLevel.INFO, message: `write ${chunks.length} chunks` });

        if (writeEntered) {
          throw StreamReentrancyError({ message: `write: reentrancy detected` });
        }

        writeEntered = true;

        try {
          return write({ chunks });
        } finally {
          writeEntered = false;
        }
      },

      finish: ({ done: providedDone }) => {

        if (failed) {
          throw StreamAlreadyFailedError({ message: `finish: cannot finish a failed stream` });
        }

        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `finish: cannot finish a destroyed stream` });
        }

        if (finishing) {
          throw StreamAlreadyFinishingError({ message: `finish: cannot finish a stream that is already finishing` });
        }

        if (finished) {
          throw StreamAlreadyFinishedError({ message: `finish: cannot finish an already finished stream` });
        }

        if (writeEntered) {
          throw StreamReentrancyError({ message: `finish: reentrancy (write) detected` });
        }

        // TODO: store state the we are waiting for a callback

        log({ level: ELogLevel.INFO, message: `finish` });

        const done = () => {
          if (failed) {
            throwWithMessage({ message: `finish: cannot finish a failed stream` });
          }

          if (destroyed) {
            throwWithMessage({ message: `finish: cannot finish a destroyed stream` });
          }

          if (finished) {
            throw Error(`cannot finish an already finished stream`);
          }

          log({ level: ELogLevel.INFO, message: `finish done` });

          finishing = false;
          finished = true;
          providedDone();
        };

        finishing = true;
        finish({ done });
      },

      destroy: ({ reason }) => {
        if (failed) {
          throw StreamAlreadyFailedError({ message: `destroy: cannot destroy a failed stream` });
        }

        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `destroy: cannot destroy a destroyed stream` });
        }

        if (finished) {
          throw StreamAlreadyFinishedError({ message: `destroy: cannot destroy a finished stream` });
        }

        log({ level: ELogLevel.INFO, message: `destroy, reason: ${reason || "unknown"}` });

        destroyed = true;
        destroy({ reason });
      },
    };
  };

  const debug: C["debug"] = ({ log: providedLog }) => {
    if (logger) {
      throw Error(`logger already set`);
    }

    logger = {
      log: providedLog
    };

    return {
      openSinkStream
    };
  };

  return {
    openSinkStream,
    debug
  };
};

export type {
  TSinkStream,
  TSinkStreamFactory,
  TSinkStreamFactoryOptions,
};

export {
  sink,
};
