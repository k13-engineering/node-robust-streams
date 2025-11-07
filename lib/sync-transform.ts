/* eslint-disable complexity */
/* eslint-disable max-statements */

import type {
  TStreamChunk,
  TStreamError,
} from "./stream.ts";
import { duplex } from "./duplex.ts";

const syncTransform = <T extends TStreamChunk, U extends TStreamChunk>({
  start = () => ({ error: undefined, chunks: [] }),
  transform,
  finish = () => ({ error: undefined, chunks: [] }),
  thresholdMin = 32,
  thresholdMax = 128,
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
    openDuplex: ({ next, end, backpressure, fail }) => {

      let finished = false;
      let destroyed = false;
      let failed = false;
      let outputBackpressure = 1;
      let ended = false;
      let started = false;

      let doneCallback: (() => void) | undefined = undefined;

      let bufferedChunks: T[] = [];
      let timeoutHandleNextTurn: NodeJS.Timeout | number | undefined = undefined;

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

      let lastPropagatedBackpressure: number | undefined = undefined;

      const maybePropagateBackpressure = () => {

        let newBackpressure = 0;

        if (outputBackpressure > 0) {
          newBackpressure = 1.0;
        } else if (bufferedChunks.length >= thresholdMin) {
          newBackpressure = (bufferedChunks.length - thresholdMin) / (thresholdMax - thresholdMin);
        }

        if (newBackpressure > 1) {
          newBackpressure = 1;
        }

        if (newBackpressure !== lastPropagatedBackpressure) {
          lastPropagatedBackpressure = newBackpressure;
          backpressure({ pressure: newBackpressure });
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

        if (destroyed || failed) {
          return;
        }

        maybePropagateBackpressure();

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

        backpressure: ({ pressure }) => {
          if (pressure < 0 || pressure > 1) {
            throw Error(`backpressure: pressure must be between 0 and 1`);
          }

          outputBackpressure = pressure;
          maybePropagateBackpressure();
        },

        write: ({ chunks }) => {

          if (failed || destroyed) {
            throw Error("cannot write to a failed or destroyed stream");
          }

          bufferedChunks = [...bufferedChunks, ...chunks];
          maybeSendNext();
        },

        finish: ({ done }) => {
          if (failed || destroyed) {
            throw Error("cannot finish a failed or destroyed stream");
          }

          // console.log(`sync transform ${name} finished`);
          finished = true;
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

export {
  syncTransform
};
