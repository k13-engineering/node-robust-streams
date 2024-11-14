/* eslint-disable complexity */
/* eslint-disable max-statements */

import type {
  IStreamFactory,
  TStreamChunk,
  TStreamError
} from "./stream.ts";
import type { ISourceStream } from "./source.ts";
import type { ISinkStream } from "./sink.ts";
import {
  StreamAlreadyDestroyedError,
  StreamAlreadyEndedError,
  StreamAlreadyFailedError,
  StreamAlreadyOpenedError,
  StreamAlreadyPausedError,
  StreamNotPausedError,
  StreamAlreadyFinishingError,
  StreamAlreadyFinishedError,
  StreamDuplexLoopError,
  StreamReentrancyError,
  StreamCallbackDuringPauseError,
  StreamResumeDuringNextError,
  StreamDrainDuringWriteError
} from "./errors.ts";

interface IDuplexStream<T extends TStreamChunk, U extends TStreamChunk> extends ISourceStream<U>, ISinkStream<T> { };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface IDuplexStreamFactoryOptions<T extends TStreamChunk, U extends TStreamChunk> {
  fail: (args: { error: TStreamError }) => void;
  next: (args: { chunks: U[] }) => void;
  end: () => void;
  drain: () => void;
};

interface IDuplexStreamFactory<T extends TStreamChunk, U extends TStreamChunk> extends IStreamFactory {
  open: (options: IDuplexStreamFactoryOptions<T, U>) => IDuplexStream<T, U>;
};

const duplex = <T extends TStreamChunk, U extends TStreamChunk>({ open }: IDuplexStreamFactory<T, U>): IDuplexStreamFactory<T, U> => {

  let opened = false;
  let paused = true;
  let failed = false;
  let destroyed = false;
  let ended = false;
  let ready = false;
  let finishing = false;
  let finished = false;

  let writeEntered = false;
  let drainEntered = false;
  let nextEntered = false;
  let resumeEntered = false;
  let pauseEntered = false;

  return {
    open: ({
      next: providedNext,
      end: providedEnd,
      drain: providedDrain,
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
          throw Error(`cannot write to a stream that never has been resumed`);
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

        if (pauseEntered) {
          throw StreamCallbackDuringPauseError({ message: `next: callbacks not allowed inside a pause call` });
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
          throw Error(`cannot end a stream that never has been resumed`);
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `end: cannot end an already ended stream` });
        }

        if (pauseEntered) {
          throw StreamCallbackDuringPauseError({ message: `end: callbacks not allowed inside a pause call` });
        }

        ended = true;
        providedEnd();
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

        if (drainEntered) {
          throw StreamReentrancyError({ message: `drain: reentrancy detected` });
        }

        if (pauseEntered) {
          throw StreamCallbackDuringPauseError({ message: `drain: callbacks not allowed inside a pause call` });
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

        if (pauseEntered) {
          throw StreamCallbackDuringPauseError({ message: `fail: callbacks not allowed inside a pause call` });
        }

        failed = true;
        providedFail({ error });
      };

      const { pause, resume, write, finish, destroy } = open({ next, end, drain, fail });

      return {
        pause: () => {
          if (destroyed) {
            throw StreamAlreadyDestroyedError({ message: `pause: cannot pause a destroyed stream` });
          }

          if (failed) {
            throw StreamAlreadyFailedError({ message: `pause: cannot pause a failed stream` });
          }

          if (paused) {
            throw StreamAlreadyPausedError({ message: `pause: cannot pause a stream that is already paused` });
          }

          if (ended) {
            throw StreamAlreadyEndedError({ message: `pause: cannot pause an ended stream` });
          }

          if (pauseEntered) {
            throw StreamReentrancyError({ message: `pause: reentrancy detected` });
          }

          pauseEntered = true;
          paused = true;

          try {
            pause();
          } finally {
            pauseEntered = false;
          }
        },

        resume: () => {
          if (destroyed) {
            throw StreamAlreadyDestroyedError({ message: `resume: cannot resume a destroyed stream` });
          }

          if (failed) {
            throw StreamAlreadyFailedError({ message: `resume: cannot resume a failed stream` });
          }

          if (ended) {
            throw StreamAlreadyEndedError({ message: `resume: cannot resume an ended stream` });
          }

          if (!paused) {
            throw StreamNotPausedError({ message: `resume: cannot resume a stream that is not paused` });
          }

          if (resumeEntered) {
            throw StreamReentrancyError({ message: `resume: reentrancy detected` });
          }

          if (nextEntered) {
            throw StreamResumeDuringNextError({ message: `resume: cannot resume a stream from within next callback` });
          }

          resumeEntered = true;
          paused = false;
          ready = true;

          try {
            resume();
          } finally {
            resumeEntered = false;
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

const syncTransform = <T extends TStreamChunk, U extends TStreamChunk>({
  start = () => ({ error: undefined, chunks: [] }),
  transform,
  finish = () => ({ error: undefined, chunks: [] }),
  thresholdMin = 20,
  thresholdMax = 100,
  maxPerTurn = Infinity
}: {
  start?: () => { error?: TStreamError, chunks?: U[] }
  transform: ({ chunks }: { chunks: T[] }) => { error?: TStreamError, chunks?: U[] },
  finish?: () => { error?: TStreamError, chunks?: U[] },
  thresholdMin?: number,
  thresholdMax?: number,
  maxPerTurn?: number
}) => {
  return duplex<T, U>({
    open: ({ next, end, drain, fail }) => {

      let ready = false;
      let finished = false;
      let destroyed = false;
      let failed = false;
      let paused = false;
      let ended = false;
      let started = false;

      let doneCallback: (() => void) | undefined = undefined;

      let bufferedChunks: T[] = [];
      let timeoutHandleNextTurn: NodeJS.Timeout | number | undefined = undefined;

      let producerWaitsForDrain = false;

      const processResult = ({ result }: { result: { error?: TStreamError, chunks?: U[] } }) => {
        if (result.error === undefined && result.chunks === undefined) {
          throw Error("sync transform must return error or chunks");
        }

        if (result.error !== undefined) {
          failed = true;
          fail({ error: result.error });
          return;
        }

        const chunksToForward = result.chunks!;

        if (chunksToForward.length > 0) {
          next({ chunks: chunksToForward });
        }
      };

      const maybeSendNext = () => {
        if (failed) {
          throw Error("BUG: maybeSendNext called altough already failed");
        }

        if (ended) {
          throw Error("BUG: maybeSendNext called altough already ended");
        }

        if (destroyed) {
          throw Error("BUG: maybeSendNext called altough already destroyed");
        }

        if (!ready) {
          return;
        }

        if (!started) {
          started = true;

          const result = start();
          processResult({ result });

          if (destroyed) {
            return;
          }
        }

        const chunks = bufferedChunks.slice(0, maxPerTurn);
        bufferedChunks = bufferedChunks.slice(maxPerTurn);

        if (chunks.length > 0) {
          const result = transform({ chunks });
          processResult({ result });

          if (destroyed) {
            return;
          }
        }

        // make sure countProcessedThisTurn is reset to 0 in next task
        if (bufferedChunks.length > 0 && timeoutHandleNextTurn === undefined) {
          timeoutHandleNextTurn = setTimeout(() => {
            timeoutHandleNextTurn = undefined;

            // if our lifecycle ended in the meantime, do nothing
            if (destroyed || failed || ended) {
              return;
            }

            maybeSendNext();
          }, 0);
        }

        // maybe send drain event to producer
        const wantsData = !paused && bufferedChunks.length < thresholdMax;
        if (producerWaitsForDrain && wantsData) {
          drain();
          producerWaitsForDrain = false;
        }

        if (destroyed || failed) {
          return;
        }

        if (bufferedChunks.length === 0 && finished) {
          const result = finish();
          processResult({ result });

          if (destroyed) {
            return;
          }

          ended = true;
          end();

          if (destroyed) {
            return;
          }

          doneCallback!();
        }
      };

      return {
        pause: () => {
          if (failed || destroyed) {
            throw Error("cannot pause a failed or destroyed stream");
          }

          paused = true;
        },

        resume: () => {
          if (failed || destroyed) {
            throw Error("cannot resume a failed or destroyed stream");
          }

          ready = true;
          paused = false;
          maybeSendNext();
        },

        write: ({ chunks }) => {

          if (failed || destroyed) {
            throw Error("cannot write to a failed or destroyed stream");
          }

          bufferedChunks = [...bufferedChunks, ...chunks];
          maybeSendNext();

          const limit = producerWaitsForDrain ? thresholdMin : thresholdMax;

          const takesMore = !paused && bufferedChunks.length < limit;

          if (!takesMore) {
            producerWaitsForDrain = true;
          }

          return {
            takesMore
          };
        },

        finish: ({ done }) => {
          if (failed || destroyed) {
            throw Error("cannot finish a failed or destroyed stream");
          }

          // console.log(`sync transform ${name} finished`);
          finished = true;
          producerWaitsForDrain = false;

          doneCallback = done;

          maybeSendNext();
        },

        destroy: () => {
          if (failed || destroyed) {
            throw Error("cannot destroy a failed or destroyed stream");
          }

          destroyed = true;
          clearTimeout(timeoutHandleNextTurn);
        }
      };
    }
  });
};

export type {
  IDuplexStream,
  IDuplexStreamFactoryOptions,
  IDuplexStreamFactory
};

export {
  duplex,
  syncTransform
};
