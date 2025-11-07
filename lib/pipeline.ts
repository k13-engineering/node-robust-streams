/* eslint-disable complexity */
/* eslint-disable max-statements */

/* eslint-disable no-use-before-define */

import type { TSourceStream, TSourceStreamFactory } from "./source.ts";
import type { TSinkStream, TSinkStreamFactory } from "./sink.ts";
import { type TDuplexStreamFactory, type TDuplexStream } from "./duplex.ts";
import type { TStreamChunk, TStreamError } from "./stream.ts";

type TPipelineNetworkStream = {
  destroy: () => void;
};

type TGenericWiring = {
  from: TSourceStreamFactory<TStreamChunk> | TDuplexStreamFactory<TStreamChunk, TStreamChunk>;
  to: TSinkStreamFactory<TStreamChunk> | TDuplexStreamFactory<TStreamChunk, TStreamChunk>;
};

type TPipelineNetworkFactoryStreamArgs = {
  done: () => void;
  failed: (args: { error: TStreamError }) => void;
};

const pipeline = <T extends TStreamChunk, U extends TStreamChunk, V extends TStreamChunk>({ from, to }: {
  from: TSourceStreamFactory<T> | TDuplexStreamFactory<U, T>,
  to: TSinkStreamFactory<T> | TDuplexStreamFactory<T, V>
}): TGenericWiring => {
  return {
    from: from as TSourceStreamFactory<TStreamChunk> | TDuplexStreamFactory<TStreamChunk, TStreamChunk>,
    to: to as TSinkStreamFactory<TStreamChunk> | TDuplexStreamFactory<TStreamChunk, TStreamChunk>
  };
};

type TPipelineNetwork = {
  rewire: (args: { network: TGenericWiring[] }) => void;
  stream: (args: TPipelineNetworkFactoryStreamArgs) => TPipelineNetworkStream;
};

const createPipelineNetwork = (): TPipelineNetwork => {

  type C = TPipelineNetwork;

  type TSourceStreamContext = {
    factory: TSourceStreamFactory<TStreamChunk>;
    stream: TSourceStream;
    ended: boolean;
    failed: boolean;
    backpressureRequestedByNetwork: number;
  };

  type TDuplexStreamContext = {
    factory: TDuplexStreamFactory<TStreamChunk, TStreamChunk>;
    stream: TDuplexStream<TStreamChunk, TStreamChunk>;
    ended: boolean;
    finishing: boolean;
    finished: boolean;
    failed: boolean;
    backpressureRequestedByNetwork: number;
    backpressureRequestedBySink: number;
  };

  type TSinkStreamContext = {
    factory: TSinkStreamFactory<TStreamChunk>;
    stream: TSinkStream<TStreamChunk>;
    finishing: boolean;
    finished: boolean;
    failed: boolean;
    backpressureRequestedBySink: number;
  };

  let sourceContexts: TSourceStreamContext[] = [];
  let duplexContexts: TDuplexStreamContext[] = [];
  let sinkContexts: TSinkStreamContext[] = [];

  let providedWirings: TGenericWiring[] = [];

  let started = false;
  let failed = false;
  let callbacks: TPipelineNetworkFactoryStreamArgs | undefined = undefined;

  const failNetwork = ({ error }: { error: TStreamError }) => {
    if (failed) {
      throw Error("BUG: pipeline network already failed");
    }

    if (callbacks === undefined) {
      throw Error("BUG: pipeline network not started");
    }

    failed = true;

    sourceContexts.forEach((s) => {
      if (s.failed || s.ended) {
        return;
      }

      s.stream.destroy();
    });

    duplexContexts.forEach((d) => {
      if (d.failed || (d.finished && d.ended)) {
        return;
      }

      d.stream.destroy();
    });

    sinkContexts.forEach((s) => {
      if (s.failed || s.finished) {
        return;
      }

      s.stream.destroy({ reason: "pipeline failed" });
    });

    callbacks!.failed({ error });
  };

  const findAndDedupeAllStreamFactories = ({ wirings }: { wirings: TGenericWiring[] }) => {
    const providedSourceOrDuplexFactories = wirings.map((w) => {
      return w.from;
    });

    const providedSinkOrDuplexFactories = wirings.map((w) => {
      return w.to;
    });

    const providedFactories = [
      ...providedSourceOrDuplexFactories,
      ...providedSinkOrDuplexFactories
    ];

    const dedupedProvidedFactories: typeof providedFactories = [];
    providedFactories.forEach((f) => {
      if (!dedupedProvidedFactories.includes(f)) {
        dedupedProvidedFactories.push(f);
      }
    });

    return dedupedProvidedFactories;
  };

  const findTargetContextsForSourceFactory = ({ factory }: { factory: TSourceStreamFactory<TStreamChunk> | TDuplexStreamFactory<TStreamChunk, TStreamChunk> }) => {
    const relevantWirings = providedWirings.filter((w) => {
      return w.from === factory;
    });

    const targetSinkFactories = relevantWirings.map((w) => {
      return w.to;
    });

    const targetSinkContexts = sinkContexts.filter((s) => {
      return targetSinkFactories.includes(s.factory);
    });

    const targetDuplexContexts = duplexContexts.filter((d) => {
      return targetSinkFactories.includes(d.factory);
    });

    const targetContexts = [...targetSinkContexts, ...targetDuplexContexts];

    return targetContexts;
  };

  const findSourceContextsForSinkFactory = ({ factory }: { factory: TSinkStreamFactory<TStreamChunk> | TDuplexStreamFactory<TStreamChunk, TStreamChunk> }) => {
    const relevantWirings = providedWirings.filter((w) => {
      return w.to === factory;
    });

    const sourceFactories = relevantWirings.map((w) => {
      return w.from;
    });

    const connectedSourceContexts = sourceContexts.filter((s) => {
      return sourceFactories.includes(s.factory);
    });

    const connectedDuplexContexts = duplexContexts.filter((d) => {
      return sourceFactories.includes(d.factory);
    });

    const sourceContextsForSink = [...connectedSourceContexts, ...connectedDuplexContexts];

    return sourceContextsForSink;
  };

  const determineBackpressureBasedOnTargetContexts = ({ targetContexts }: {
    targetContexts: (TSinkStreamContext | TDuplexStreamContext)[]
  }) => {
    let backpressure = 0;

    // naive strategy: if any target requests backpressure == 1, propagate backpressure 1
    targetContexts.forEach((targetContext) => {
      if (targetContext.backpressureRequestedBySink >= 1) {
        backpressure = 1;
      }
    });

    return backpressure;
  };

  const updateBackpressureOfSourceContext = ({ sourceContext }: {
    sourceContext: TSourceStreamContext | TDuplexStreamContext
  }) => {
    const targetContexts = findTargetContextsForSourceFactory({ factory: sourceContext.factory });

    const backpressure = determineBackpressureBasedOnTargetContexts({ targetContexts });

    // needed to avoid infinite loops
    if (sourceContext.backpressureRequestedByNetwork !== backpressure) {
      sourceContext.backpressureRequestedByNetwork = backpressure;
      sourceContext.stream.backpressure({ pressure: backpressure });
    }
  };

  const updateBackpressure = ({ targetContext }: { targetContext: TSinkStreamContext | TDuplexStreamContext }) => {
    targetContext;

    // const affectedSourceContexts = findSourceContextsForSinkFactory({ factory: targetContext.factory });
    const affectedSourceContexts = [
      ...sourceContexts, ...duplexContexts
    ];

    affectedSourceContexts.forEach((sourceContext) => {
      updateBackpressureOfSourceContext({ sourceContext });
    });
  };

  const forwardChunksToTargetContexts = ({ chunks, targetContexts }: {
    chunks: TStreamChunk[],
    targetContexts: (TSinkStreamContext | TDuplexStreamContext)[]
  }) => {
    targetContexts.forEach((targetContext) => {
      targetContext.stream.write({ chunks });

      // a stream might have failed during write

      if (failed) {
        return;
      }
    });
  };

  let maybeEndEntered = false;

  const maybeEndStreams = () => {

    if (maybeEndEntered) {
      throw Error("BUG: maybeEndStreams reentrancy detected");
    }

    maybeEndEntered = true;

    const targetContexts = [
      ...sinkContexts,
      ...duplexContexts
    ];

    targetContexts.forEach((targetContext) => {

      if (targetContext.finishing || targetContext.finished) {
        return;
      }

      const connectedSourceContexts = findSourceContextsForSinkFactory({ factory: targetContext.factory });

      const allConnectedSourcesEnded = connectedSourceContexts.every((s) => {
        return s.ended;
      });

      if (allConnectedSourcesEnded) {

        targetContext.finishing = true;

        targetContext.stream.finish({
          done: () => {
            targetContext.finished = true;
            maybeEmitDone();
          }
        });
      }
    });

    maybeEndEntered = false;
  };

  let doneEmitted = false;

  const maybeEmitDone = () => {

    if (doneEmitted) {
      throw Error("BUG: done already emitted");
    }

    let done = true;

    sourceContexts.forEach((s) => {
      if (!s.ended) {
        done = false;
      }
    });

    duplexContexts.forEach((d) => {
      if (!d.ended || !d.finished) {
        done = false;
      }
    });

    sinkContexts.forEach((s) => {
      if (!s.finished) {
        done = false;
      }
    });

    if (done) {
      doneEmitted = true;
      callbacks!.done();
    }
  };

  let maybeEndScheduleHandle: NodeJS.Timeout | undefined = undefined;
  const scheduleMaybeEndStreams = () => {
    if (maybeEndScheduleHandle !== undefined) {
      return;
    }

    maybeEndScheduleHandle = setTimeout(() => {
      maybeEndScheduleHandle = undefined;
      maybeEndStreams();
    }, 0);
  };

  const maybeUpdateStreams = () => {
    if (!started) {
      return;
    }

    const streamFactories = findAndDedupeAllStreamFactories({ wirings: providedWirings });

    const duplexFactories = streamFactories.filter((f) => {
      return (f as TDuplexStreamFactory<TStreamChunk, TStreamChunk>).openDuplex !== undefined;
    }) as TDuplexStreamFactory<TStreamChunk, TStreamChunk>[];

    // TODO: check lose ends

    const sourceFactories = streamFactories.filter((f) => {
      return (f as TSourceStreamFactory<TStreamChunk>).openSourceStream !== undefined;
    }) as TSourceStreamFactory<TStreamChunk>[];

    const sinkFactories = streamFactories.filter((f) => {
      return (f as TSinkStreamFactory<TStreamChunk>).openSinkStream !== undefined;
    }) as TSinkStreamFactory<TStreamChunk>[];

    const duplexFactoriesToCreateStreamsFor = duplexFactories.filter((f) => {
      const existing = duplexContexts.find((s) => {
        return s.factory === f;
      });

      return existing === undefined;
    });

    const sourceFactoriesToCreateStreamsFor = sourceFactories.filter((f) => {
      const existing = sourceContexts.find((s) => {
        return s.factory === f;
      });

      return existing === undefined;
    });

    const sinkFactoriesToCreateStreamsFor = sinkFactories.filter((f) => {
      const existing = sinkContexts.find((s) => {
        return s.factory === f;
      });

      return existing === undefined;
    });

    const duplexStreamsToRemove = duplexContexts.filter((s) => {
      return !duplexFactories.includes(s.factory);
    });

    const sourceStreamsToRemove = sourceContexts.filter((s) => {
      return !sourceFactories.includes(s.factory);
    });

    const sinkStreamsToRemove = sinkContexts.filter((s) => {
      return !sinkFactories.includes(s.factory);
    });

    duplexStreamsToRemove.forEach((s) => {
      if (!s.finished || !s.ended) {
        s.stream.destroy();
      }

      duplexContexts = duplexContexts.filter((ss) => {
        return ss !== s;
      });
    });

    sourceStreamsToRemove.forEach((s) => {
      if (!s.ended) {
        s.stream.destroy();
      }

      sourceContexts = sourceContexts.filter((ss) => {
        return ss !== s;
      });
    });

    sinkStreamsToRemove.forEach((s) => {
      if (!s.finished) {
        s.stream.destroy({ reason: "removed from pipeline" });
      }

      sinkContexts = sinkContexts.filter((ss) => {
        return ss !== s;
      });
    });

    duplexFactoriesToCreateStreamsFor.forEach((f) => {

      const newDuplexContext: TDuplexStreamContext = {
        factory: f,
        ended: false,
        finishing: false,
        finished: false,
        failed: false,
        backpressureRequestedByNetwork: 1,
        backpressureRequestedBySink: 1,
        stream: f.openDuplex({
          backpressure: ({ pressure }) => {
            newDuplexContext.backpressureRequestedBySink = pressure;
            updateBackpressure({ targetContext: newDuplexContext });
          },

          next: ({ chunks }) => {
            const targetContexts = findTargetContextsForSourceFactory({ factory: f });
            forwardChunksToTargetContexts({ chunks, targetContexts });
          },

          end: () => {
            newDuplexContext.ended = true;
            scheduleMaybeEndStreams();
            maybeEmitDone();
          },

          fail: ({ error }) => {
            newDuplexContext.failed = true;
            failNetwork({ error });
          },
        })
      };

      duplexContexts = [
        ...duplexContexts,
        newDuplexContext
      ];
    });

    sourceFactoriesToCreateStreamsFor.forEach((f) => {

      const newSourceContext: TSourceStreamContext = {
        factory: f,
        ended: false,
        failed: false,
        backpressureRequestedByNetwork: 1,
        stream: f.openSourceStream({
          next: ({ chunks }) => {
            const targetContexts = findTargetContextsForSourceFactory({ factory: f });
            forwardChunksToTargetContexts({ chunks, targetContexts });
          },

          end: () => {
            newSourceContext.ended = true;
            scheduleMaybeEndStreams();
            maybeEmitDone();
          },

          fail: ({ error }) => {
            failNetwork({ error });
          }
        })
      };

      sourceContexts = [
        ...sourceContexts,
        newSourceContext
      ];
    });

    sinkFactoriesToCreateStreamsFor.forEach((f) => {
      const newSinkContext: TSinkStreamContext = {
        factory: f,
        finishing: false,
        finished: false,
        failed: false,
        backpressureRequestedBySink: 1,
        stream: f.openSinkStream({
          backpressure: ({ pressure }) => {
            newSinkContext.backpressureRequestedBySink = pressure;
            updateBackpressure({ targetContext: newSinkContext });
          },

          fail: ({ error }) => {
            newSinkContext.failed = true;
            failNetwork({ error });
          },
        })
      };

      sinkContexts = [
        ...sinkContexts,
        newSinkContext
      ];
    });
  };

  const rewire: C["rewire"] = ({ network }) => {
    providedWirings = network;
    maybeUpdateStreams();
  };

  const stream: C["stream"] = ({ done, failed: failedCallback }) => {

    callbacks = { done, failed: failedCallback };
    started = true;
    maybeUpdateStreams();

    const destroy = () => {
    };

    return {
      destroy
    };
  };

  return {
    rewire,
    stream
  };
};

export {
  pipeline,
  createPipelineNetwork
};
