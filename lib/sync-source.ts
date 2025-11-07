/* eslint-disable complexity */
/* eslint-disable max-statements */

import { source, type TSourceStream } from "./source.ts";
import { type TStreamChunk } from "./stream.ts";

type TSyncSourceReadArgs = {
  hints: {
    amount: number;
  }
};

type TSyncSourceReadResult<T extends TStreamChunk> = {
  error: Error;
  chunks: undefined;
  end: undefined;
} | {
  error: undefined;
  chunks: T[];
  end: false;
} | {
  error: undefined;
  chunks: undefined;
  end: true;
};

const syncSource = <T extends TStreamChunk>({
  read: providedRead,
  destroy: providedDestroy = () => { },
  maxPerTurn = Infinity
}: {
  read: (args: TSyncSourceReadArgs) => TSyncSourceReadResult<T>;
  destroy?: () => void;
  maxPerTurn?: number;
}) => {
  let destroyed = false;
  let ended = false;

  type C = TSourceStream;

  return source<T>({
    openSourceStream: ({ next, end, fail }) => {

      let currentBackpressure = 1;

      const maybeSendNext = () => {

        let remaining = maxPerTurn;

        while (remaining > 0 && currentBackpressure < 1 && !ended && !destroyed) {

          const { error, chunks, end: sourceEnded } = providedRead({ hints: { amount: 16384 } });

          if (error !== undefined) {
            fail({ error });
            return;
          }

          if (sourceEnded) {
            ended = true;
            end();
            return;
          }

          next({ chunks });

          remaining = Math.max(0, remaining - chunks.length);
        }

        // eslint-disable-next-line no-use-before-define
        maybeScheduleNext();
      };

      let nextScheduleHandle: NodeJS.Timeout | number | undefined = undefined;
      const maybeScheduleNext = () => {

        if (destroyed) {
          return;
        }

        if (ended) {
          return;
        }

        if (currentBackpressure >= 1) {
          return;
        }

        if (nextScheduleHandle !== undefined) {
          return;
        }

        nextScheduleHandle = setTimeout(() => {
          nextScheduleHandle = undefined;
          maybeSendNext();
        }, 0);
      };

      const backpressure: C["backpressure"] = ({ pressure }) => {
        currentBackpressure = pressure;
        maybeScheduleNext();
      };

      const destroy: C["destroy"] = () => {
        destroyed = true;

        if (nextScheduleHandle !== undefined) {
          clearTimeout(nextScheduleHandle);
          nextScheduleHandle = undefined;
        }

        providedDestroy();
      };

      return {
        backpressure,
        destroy
      };
    }
  });
};

export {
  syncSource
};

export type {
  TSyncSourceReadArgs,
  TSyncSourceReadResult
};
