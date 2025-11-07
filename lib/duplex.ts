/* eslint-disable complexity */
/* eslint-disable max-statements */

import type {
  TStreamChunk,
  TStreamError,
} from "./stream.ts";
import type { TSourceStream, TSourceStreamFactoryOptions } from "./source.ts";
import type { TSinkStream, TSinkStreamFactoryOptions } from "./sink.ts";
import {
  StreamAlreadyDestroyedError,
  StreamAlreadyEndedError,
  StreamAlreadyFailedError,
  StreamAlreadyOpenedError,
  StreamAlreadyFinishingError,
  StreamAlreadyFinishedError,
  StreamDuplexLoopError,
  StreamReentrancyError,
} from "./errors.ts";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type TDuplexStream<T extends TStreamChunk, U extends TStreamChunk> = TSinkStream<T> & TSourceStream;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type TDuplexStreamFactoryOptions<T extends TStreamChunk, U extends TStreamChunk> = TSinkStreamFactoryOptions & TSourceStreamFactoryOptions<U>;

type TDuplexStreamFactory<T extends TStreamChunk, U extends TStreamChunk> = {
  openDuplex: (options: TDuplexStreamFactoryOptions<T, U>) => TDuplexStream<T, U>;
};

const duplex = <T extends TStreamChunk, U extends TStreamChunk>({ openDuplex }: TDuplexStreamFactory<T, U>): TDuplexStreamFactory<T, U> => {

  let opened = false;
  let failed = false;
  let destroyed = false;
  let ended = false;
  let ready = false;
  let finishing = false;
  let finished = false;

  let writeEntered = false;
  let backpressureEntered = false;
  let nextEntered = false;

  return {
    openDuplex: ({
      next: providedNext,
      end: providedEnd,
      backpressure: providedBackpressure,
      fail: providedFail
    }) => {
      if (opened) {
        throw StreamAlreadyOpenedError({ message: `cannot open a stream that is already open` });
      }

      opened = true;

      const next = ({ chunks }: { chunks: U[] }) => {
        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `next: cannot write to a destroyed stream` });
        }

        if (failed) {
          throw StreamAlreadyFailedError({ message: `next: cannot write to a failed stream` });
        }

        if (!ready) {
          throw Error(`cannot write during opening of the stream`);
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `next: cannot write to an ended stream` });
        }

        if (chunks.length === 0) {
          throw Error(`cannot write an empty chunk array`);
        }

        if (nextEntered) {
          throw StreamReentrancyError({ message: `next: reentrancy detected` });
        }

        nextEntered = true;
        try {
          providedNext({ chunks });
        } finally {
          nextEntered = false;
        }
      };

      const end = () => {
        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `end: cannot end a destroyed stream` });
        }

        if (failed) {
          throw StreamAlreadyFailedError({ message: `end: cannot end a failed stream` });
        }

        if (!ready) {
          throw Error(`cannot end during opening of the stream`);
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `end: cannot end an already ended stream` });
        }

        ended = true;
        providedEnd();
      };

      const fail = ({ error }: { error: TStreamError }) => {
        if (failed) {
          throw StreamAlreadyFailedError({ message: `fail: cannot fail a stream that is already failed` });
        }

        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `fail: cannot fail a stream that is already destroyed` });
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `fail: cannot fail a stream that is already ended` });
        }

        if (error === undefined) {
          throw Error(`cannot fail a stream with an undefined error`);
        }

        failed = true;
        providedFail({ error });
      };

      const backpressure = ({ pressure }: { pressure: number }) => {
        if (pressure < 0 || pressure > 1) {
          throw Error(`backpressure: pressure must be between 0 and 1`);
        }

        if (failed) {
          throw StreamAlreadyFailedError({ message: `backpressure: cannot backpressure a stream that is already failed` });
        }

        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `backpressure: cannot backpressure a stream that is already destroyed` });
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `backpressure: cannot backpressure a stream that is already ended` });
        }

        providedBackpressure({ pressure });
      };

      const { backpressure: backpressureImpl, write, finish, destroy } = openDuplex({ next, end, backpressure, fail });
      ready = true;

      return {

        backpressure: ({ pressure }) => {
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

          if (backpressureEntered) {
            throw StreamReentrancyError({ message: `backpressure: reentrancy detected` });
          }

          backpressureEntered = true;

          try {
            backpressureImpl({ pressure });
          } finally {
            backpressureEntered = false;
          }
        },


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

          if (writeEntered) {
            throw StreamReentrancyError({ message: `write: reentrancy detected` });
          }

          if (nextEntered) {
            throw StreamDuplexLoopError({ message: `write: cannot write to stream from within next callback` });
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

          // TODO: store state the we are waiting for a callback

          const done = () => {
            if (failed) {
              throw StreamAlreadyFailedError({ message: `finish (done callback): cannot finish a failed stream` });
            }

            if (destroyed) {
              throw StreamAlreadyDestroyedError({ message: `finish (done callback): cannot finish a destroyed stream` });
            }

            if (finished) {
              throw StreamAlreadyFinishedError({ message: `finish (done callback): cannot finish an already finished stream` });
            }

            finishing = false;
            finished = true;
            providedDone();
          };

          finishing = true;
          finish({ done });
        },

        destroy: () => {
          if (failed) {
            throw StreamAlreadyFailedError({ message: `destroy: cannot destroy a failed stream` });
          }

          if (destroyed) {
            throw StreamAlreadyDestroyedError({ message: `destroy: cannot destroy a destroyed stream` });
          }

          if (finished && ended) {
            throw StreamAlreadyFinishedError({ message: `destroy: cannot destroy a finished and ended duplex stream` });
          }

          destroyed = true;
          destroy();
        }
      };
    }
  };
};


export type {
  TDuplexStream,
  TDuplexStreamFactoryOptions,
  TDuplexStreamFactory
};

export {
  duplex,
};
