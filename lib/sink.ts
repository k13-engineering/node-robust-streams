/* eslint-disable complexity */
/* eslint-disable max-statements */

import type {
  IStreamFactory,
  IStream,
  TStreamChunk,
  TStreamError
} from "./stream.ts";
import { ELogLevel } from "./debug.ts";
import type { ILogger } from "./debug.ts";
import {
  StreamAlreadyDestroyedError,
  StreamAlreadyFailedError,
  StreamAlreadyFinishedError,
  StreamAlreadyFinishingError,
  StreamReentrancyError,
  StreamDrainDuringWriteError
} from "./errors.ts";

interface ISinkStream<T extends TStreamChunk> extends IStream {
  write: ({ chunks }: { chunks: T[] }) => { takesMore: boolean };
  finish: ({ done }: { done: () => void }) => void;
};

interface ISinkStreamFactoryOptions {
  drain: () => void;
  fail: ({ error }: { error: TStreamError }) => void;
};

interface ISinkStreamFactory<T extends TStreamChunk> extends IStreamFactory {
  open: (options: ISinkStreamFactoryOptions) => ISinkStream<T>;
};

interface IDebuggableSinkStreamFactory<T extends TStreamChunk> extends ISinkStreamFactory<T> {
  debug: (args: { log: (args: { message: string }) => void }) => ISinkStreamFactory<T>;
};

const sink = <T extends TStreamChunk>({ open: providedOpen }: ISinkStreamFactory<T>): IDebuggableSinkStreamFactory<T> => {
  let opened = false;
  let finishing = false;
  let finished = false;
  let destroyed = false;
  let failed = false;

  let logger: ILogger | undefined = undefined;
  const log = ({ level, message }: { level: ELogLevel, message: string }) => {
    if (logger) {
      logger.log({ level, message });
    }
  };

  const throwWithMessage = ({ message }: { message: string }) => {
    log({ level: ELogLevel.ERROR, message });
    throw Error(message);
  };

  let writeEntered = false;
  let drainEntered = false;

  const open: ISinkStreamFactory<T>["open"] = ({ drain: providedDrain, fail: providedFail }): ISinkStream<T> => {

    if (opened) {
      throw Error(`cannot open a stream that is already open`);
    }

    opened = true;

    const fail = ({ error }: { error: TStreamError }) => {
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

    const drain = () => {
      if (failed) {
        throw StreamAlreadyFailedError({ message: `drain: cannot drain a stream that is already failed` });
      }

      if (destroyed) {
        throw StreamAlreadyDestroyedError({ message: `drain: cannot drain a stream that is already destroyed` });
      }

      if (finishing) {
        throw StreamAlreadyFinishingError({ message: `drain: cannot drain a stream that is finishing` });
      }

      if (finished) {
        throw StreamAlreadyFinishedError({ message: `drain: cannot drain a stream that is already finished` });
      }

      log({ level: ELogLevel.INFO, message: `drain` });

      if (drainEntered) {
        throw StreamReentrancyError({ message: `drain: reentrancy detected` });
      }

      if (writeEntered) {
        throw StreamDrainDuringWriteError({ message: `drain: cannot drain during write` });
      }

      drainEntered = true;

      try {
        providedDrain();
      } finally {
        drainEntered = false;
      }
    };

    log({ level: ELogLevel.INFO, message: `open` });
    const { write, finish, destroy } = providedOpen({ drain, fail });

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

      destroy: ({ reason } = {}) => {
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
        destroy();
      },
    };
  };

  const debug: IDebuggableSinkStreamFactory<T>["debug"] = ({ log: providedLog }) => {
    if (logger) {
      throw Error(`logger already set`);
    }

    logger = {
      log: providedLog
    };

    return {
      open
    };
  };

  return {
    open,
    debug
  };
};

const syncSink = <T extends TStreamChunk>({
  write: providedWrite,
  finish: providedFinish,
  destroy: providedDestroy
}: {
  write: (args: { chunks: T[] }) => void,
  finish: () => void,
  destroy: () => void
}) => {
  return sink({
    open: () => {
      const write = ({ chunks }: { chunks: T[] }) => {
        providedWrite({ chunks });

        return {
          takesMore: true
        };
      };

      const finish = ({ done }: { done: () => void }) => {
        providedFinish();
        done();
      };

      const destroy = () => {
        providedDestroy();
      };

      return {
        write,
        finish,
        destroy
      };
    }
  });
};

const nullSink = () => {
  return syncSink({
    write: () => {
      // unused
    },

    finish: () => {
      // unused
    },

    destroy: () => {
      // unused
    }
  });
};

export type {
  ISinkStream,
  ISinkStreamFactory,
  ISinkStreamFactoryOptions,
};

export {
  sink,
  syncSink,
  nullSink
};
