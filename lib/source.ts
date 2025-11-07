/* eslint-disable complexity */
/* eslint-disable max-statements */

import {
  StreamAlreadyDestroyedError,
  StreamAlreadyEndedError,
  StreamAlreadyFailedError,
  StreamAlreadyOpenedError,
  StreamCallbackDuringBackpressureError,
  StreamReentrancyError,
} from "./errors.ts";

import type {
  TStreamBackpressureFunc,
  TStreamChunk,
  TStreamError,
  TStreamFailFunc
} from "./stream.ts";

type TSourceStream = {
  destroy: () => void;
  backpressure: TStreamBackpressureFunc;
};

type TSourceStreamFactoryOptions<T extends TStreamChunk> = {
  next: ({ chunks }: { chunks: T[] }) => void;
  end: () => void;
  fail: TStreamFailFunc;
};

type TSourceStreamFactory<T extends TStreamChunk> = {
  openSourceStream: (options: TSourceStreamFactoryOptions<T>) => TSourceStream;
};

const source = <T extends TStreamChunk>({ openSourceStream }: TSourceStreamFactory<T>): TSourceStreamFactory<T> => {
  let opened = false;
  let failed = false;
  let destroyed = false;
  let ended = false;

  let nextEntered = false;
  let endEntered = false;
  let failEntered = false;
  let backpressureEntered = false;
  let destroyEntered = false;

  return {

    openSourceStream: ({ next: providedNext, end: providedEnd, fail: providedFail }) => {

      if (opened) {
        throw StreamAlreadyOpenedError({ message: `cannot open a stream that is already open` });
      }

      const next = ({ chunks }: { chunks: T[] }) => {

        if (!opened) {
          throw Error(`cannot call next before open returns`);
        }

        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `next: cannot write to a destroyed stream` });
        }

        if (failed) {
          throw StreamAlreadyFailedError({ message: `next: cannot write to a failed stream` });
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `next: cannot write to an ended stream` });
        }

        if (chunks.length === 0) {
          throw Error(`cannot write an empty chunk array`);
        }

        if (backpressureEntered) {
          throw StreamCallbackDuringBackpressureError({ message: `next: callbacks not allowed inside a backpressure call` });
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

        if (!opened) {
          throw Error(`cannot call end before open returns`);
        }

        if (destroyed) {
          throw StreamAlreadyDestroyedError({ message: `end: cannot end a destroyed stream` });
        }

        if (failed) {
          throw StreamAlreadyFailedError({ message: `end: cannot end a failed stream` });
        }

        if (ended) {
          throw StreamAlreadyEndedError({ message: `end: cannot end an already ended stream` });
        }

        if (backpressureEntered) {
          throw StreamCallbackDuringBackpressureError({ message: `end: callbacks not allowed inside a backpressure call` });
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

        if (backpressureEntered) {
          throw StreamCallbackDuringBackpressureError({ message: `fail: callbacks not allowed inside a backpressure call` });
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

      const { backpressure, destroy } = openSourceStream({ next, end, fail });
      opened = true;

      return {

        backpressure: ({ pressure }: { pressure: number }) => {
          if (destroyed) {
            throw StreamAlreadyDestroyedError({ message: `backpressure: cannot signal backpressure on a destroyed stream` });
          }

          if (failed) {
            throw StreamAlreadyFailedError({ message: `backpressure: cannot signal backpressure on a failed stream` });
          }

          if (ended) {
            throw StreamAlreadyEndedError({ message: `backpressure: cannot signal backpressure on an ended stream` });
          }

          if (backpressureEntered) {
            throw StreamReentrancyError({ message: `backpressure: reentrancy detected` });
          }

          if (endEntered) {
            throw StreamReentrancyError({ message: `backpressure: reentrancy detected` });
          }

          if (failEntered) {
            throw StreamReentrancyError({ message: `backpressure: reentrancy detected` });
          }

          if (destroyEntered) {
            throw StreamReentrancyError({ message: `backpressure: reentrancy detected` });
          }

          backpressureEntered = true;

          try {
            backpressure({ pressure });
          } finally {
            backpressureEntered = false;
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
    openSourceStream: ({ fail }) => {
      fail({ error });

      return {
        backpressure: () => {
        },

        destroy: () => {
          // unused
        }
      };
    }
  });
};

export type {
  TSourceStream,
  TSourceStreamFactory,
  TSourceStreamFactoryOptions,
};

export {
  source,
  errorSource
};
