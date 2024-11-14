/* eslint-disable complexity */
/* eslint-disable max-statements */

import {
  StreamAlreadyDestroyedError,
  StreamAlreadyEndedError,
  StreamAlreadyFailedError,
  StreamAlreadyOpenedError,
  StreamAlreadyPausedError,
  StreamNotPausedError,
  StreamReentrancyError,
  StreamResumeDuringNextError,
  StreamCallbackDuringPauseError
} from "./errors.ts";

import type {
  IStreamFactory,
  IStream,
  TStreamChunk,
  TStreamError
} from "./stream.ts";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ISourceStream<T extends TStreamChunk> extends IStream {
  pause: () => void;
  resume: () => void;
};

interface ISourceStreamFactoryOptions<T extends TStreamChunk> {
  next: ({ chunks }: { chunks: T[] }) => void;
  end: () => void;
  fail: ({ error }: { error: globalThis.Error }) => void;
};

interface ISourceStreamFactory<T extends TStreamChunk> extends IStreamFactory {
  open: (options: ISourceStreamFactoryOptions<T>) => ISourceStream<T>;
};

const source = <T extends TStreamChunk>({ open }: ISourceStreamFactory<T>): ISourceStreamFactory<T> => {
  let opened = false;
  let paused = true;
  let failed = false;
  let destroyed = false;
  let ended = false;
  let ready = false;

  let nextEntered = false;
  let endEntered = false;
  let failEntered = false;
  let pauseEntered = false;
  let resumeEntered = false;
  let destroyEntered = false;

  return {

    open: ({ next: providedNext, end: providedEnd, fail: providedFail }) => {

      if (opened) {
        throw StreamAlreadyOpenedError({ message: `cannot open a stream that is already open` });
      }

      opened = true;

      const next = ({ chunks }: { chunks: T[] }) => {
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

        if (pauseEntered) {
          throw StreamCallbackDuringPauseError({ message: `next: callbacks not allowed inside a pause call` });
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
          throw Error(`cannot end a stream that never has been resumed`);
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `end: cannot end an already ended stream` });
        }

        if (pauseEntered) {
          throw StreamCallbackDuringPauseError({ message: `end: callbacks not allowed inside a pause call` });
        }

        // resume is allowed
        if (nextEntered) {
          throw StreamReentrancyError({ message: `end: reentrancy detected` });
        }

        endEntered = true;
        ended = true;

        try {
          providedEnd();
        } finally {
          endEntered = false;
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

        // resume is allowed
        if (nextEntered) {
          throw StreamReentrancyError({ message: `fail: reentrancy detected` });
        }

        failEntered = true;
        failed = true;

        try {
          providedFail({ error });
        } finally {
          failEntered = false;
        }
      };

      opened = true;
      const { pause, resume, destroy } = open({ next, end, fail });

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

          // resume and next is allowed
          if (endEntered || failEntered || destroyEntered) {
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

          if (nextEntered) {
            throw StreamResumeDuringNextError({ message: `resume: cannot resume a stream during a next call` });
          }

          if (pauseEntered) {
            throw StreamReentrancyError({ message: `resume: reentrancy detected` });
          }

          if (resumeEntered) {
            throw StreamReentrancyError({ message: `resume: reentrancy detected` });
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

        destroy: () => {
          if (destroyed) {
            throw StreamAlreadyDestroyedError({ message: `destroy: cannot destroy a destroyed stream` });
          }

          if (failed) {
            throw StreamAlreadyFailedError({ message: `destroy: cannot destroy a failed stream` });
          }

          if (ended) {
            throw StreamAlreadyEndedError({ message: `destroy: cannot destroy an ended stream` });
          }

          destroyEntered = true;
          paused = true;
          destroyed = true;

          try {
            destroy();
          } finally {
            destroyEntered = false;
          }
        }
      };
    }
  };
};

const errorSource = ({ error }: { error: TStreamError }) => {
  return source({
    open: ({ fail }) => {
      fail({ error });

      return {
        pause: () => {
          // unused
        },

        resume: () => {
          // unused
        },

        destroy: () => {
          // unused
        }
      };
    }
  });
};

const sourceFromString = ({ data, chunkSize }: { data: string, chunkSize?: number }) => {
  let destroyed = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const chunkSizeToUse = chunkSize || data.length;

  return source<string>({
    open: ({ next, end }) => {

      return {
        pause: () => {
          // unused
        },

        resume: () => {
          next({ chunks: [data] });

          if (destroyed) {
            return;
          }

          end();
        },

        destroy: () => {
          destroyed = true;
        }
      };
    }
  });
};

const sourceFromChunks = <T extends TStreamChunk>({ chunks }: { chunks: T[] }) => {
  let destroyed = false;

  return source<T>({
    open: ({ next, end }) => {

      return {
        pause: () => {
          // unused
        },

        resume: () => {
          if (chunks.length > 0) {
            next({ chunks });

            if (destroyed) {
              return;
            }
          }

          end();
        },

        destroy: () => {
          destroyed = true;
        }
      };
    }
  });
};

export type {
  ISourceStream,
  ISourceStreamFactory,
  ISourceStreamFactoryOptions
};

export {
  source,
  errorSource,
  sourceFromString,
  sourceFromChunks
};
