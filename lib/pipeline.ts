/* eslint-disable complexity */
/* eslint-disable max-statements */

/* eslint-disable no-use-before-define */

import type { ISourceStreamFactory } from "./source.ts";
import type { ISinkStreamFactory } from "./sink.ts";
import type { IDuplexStreamFactory } from "./duplex.ts";
import type { IStreamFactory, TStreamChunk, TStreamError } from "./stream.ts";

import { sink } from "./sink.ts";
import { source } from "./source.ts";
import { duplex } from "./duplex.ts";

interface IPipelineNetworkStream {
  destroy: () => void;
};

interface IPipelineNetworkFactoryStreamArgs {
  done: () => void;
  failed: (args: { error: TStreamError }) => void;
};

interface IPipelineNetworkFactory {
  stream: (args: IPipelineNetworkFactoryStreamArgs) => IPipelineNetworkStream;
};

interface IRewireWiring<T extends TStreamChunk, U extends TStreamChunk, V extends TStreamChunk, W extends TStreamChunk> {
  from: ISourceStreamFactory<T>;
  via: IDuplexStreamFactory<V, W>[];
  to: ISinkStreamFactory<U>;
}

interface IRewireablePipelineNetworkFactory extends IPipelineNetworkFactory {
  rewire: <
    T extends TStreamChunk,
    U extends TStreamChunk,
    V extends TStreamChunk,
    W extends TStreamChunk
  >(args: { wirings: IRewireWiring<T, U, V, W>[] }) => void;
};

interface IInternalHandle {
  factory: IStreamFactory;
  destroy: () => void;
};

interface IInternalSourceHandle extends IInternalHandle {
  pause: () => void;
  resume: () => void;
  status: () => {
    paused: boolean;
    ended: boolean;
  }
};

interface IInternalSinkHandle extends IInternalHandle {
  write: (args: { chunks: TStreamChunk[] }) => void;
  finish: (args: { done: () => void }) => void;
  status: () => {
    takesMore: boolean;
    finishing: boolean;
    finished: boolean;
  }
};

interface IInternalConnection {
  source: IInternalSourceHandle;
  sink: IInternalSinkHandle;
};

const create = (): IRewireablePipelineNetworkFactory => {

  let connections: IInternalConnection[] = [];
  // TODO: HACK: LEAK!!
  let internalSourceHandles: IInternalSourceHandle[] = [];
  let internalSinkHandles: IInternalSinkHandle[] = [];

  const handleNext = ({ source: internalSourceHandle, chunks }: { source: IInternalSourceHandle, chunks: TStreamChunk[] }) => {
    const targets = findTargetStreamsOfSource({ source: internalSourceHandle });

    targets.forEach((targetSink) => {
      if (destroyed) {
        return;
      }

      targetSink.write({ chunks });
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleFail = ({ error }: { error: TStreamError }) => {
    throw Error("not implemented yet", { cause: error });
  };

  const maybeFinishSome = () => {
    const sinks = findAllInternalSinks();
    sinks.forEach((internalSink) => {
      const sinkStatus = internalSink.status();

      if (sinkStatus.finishing) {
        return;
      }

      const sources = findSourceStreamsOfSink({ sink: internalSink });

      const allSourcesEnded = sources.every((src) => {
        const sourceStatus = src.status();
        return sourceStatus.ended;
      });

      if (allSourcesEnded) {
        internalSink.finish({ done: () => { } });
      }
    });
  };

  const maybeCreateSourceHandle = ({ source: sourceFactory }: { source: ISourceStreamFactory<TStreamChunk> }): IInternalSourceHandle => {
    const existingHandle = internalSourceHandles.find((handle) => {
      return handle.factory === sourceFactory;
    });

    if (existingHandle !== undefined) {
      return existingHandle;
    }

    let paused = true;
    let ended = false;

    const stream = sourceFactory.open({
      next: ({ chunks }) => {
        handleNext({ source: self, chunks });
      },

      end: () => {
        ended = true;
        maybeFinishSome();
      },

      fail: ({ error }) => {
        handleFail({ error });
      }
    });

    const self: IInternalSourceHandle = {
      factory: sourceFactory,

      pause: () => {
        paused = true;
        stream.pause();
        maybePauseOrResume();
      },
      resume: () => {
        paused = false;
        stream.resume();
        maybePauseOrResume();
      },
      destroy: () => {
        stream.destroy();
      },

      status: () => {
        return {
          paused,
          ended
        };
      }
    };

    internalSourceHandles = [
      ...internalSourceHandles,
      self
    ];

    return self;
  };

  const maybeCreateSinkHandle = ({ factory }: { factory: ISinkStreamFactory<TStreamChunk> }): IInternalSinkHandle => {
    const existingHandle = internalSinkHandles.find((handle) => {
      return handle.factory === factory;
    });

    if (existingHandle !== undefined) {
      return existingHandle;
    }

    let takesMore = true;
    let finishing = false;
    let finished = false;

    const stream = factory.open({
      drain: () => {
        takesMore = true;
        maybePauseOrResume();
      },

      fail: ({ error }) => {
        handleFail({ error });
      }
    });

    const self: IInternalSinkHandle = {
      factory,

      write: ({ chunks }) => {
        const result = stream.write({ chunks });

        if (!result.takesMore && takesMore === true) {
          takesMore = false;
          maybePauseOrResume();
        }
      },

      finish: () => {
        finishing = true;
        stream.finish({
          done: () => {
            finished = true;
            maybePipelineDone();
          }
        });
      },

      destroy: () => {
        stream.destroy();
      },

      status: () => {
        return {
          takesMore,
          finishing,
          finished
        };
      }
    };

    internalSinkHandles = [
      ...internalSinkHandles,
      self
    ];

    return self;
  };

  const maybeCreateDuplexHandle = ({
    factory
  }: {
    factory: IDuplexStreamFactory<TStreamChunk, TStreamChunk>
  }): { source: IInternalSourceHandle, sink: IInternalSinkHandle } => {

    const existingSourceHandle = internalSourceHandles.find((handle) => {
      return handle.factory === factory;
    });

    const existingSinkHandle = internalSinkHandles.find((handle) => {
      return handle.factory === factory;
    });

    if (existingSourceHandle !== undefined && existingSinkHandle !== undefined) {
      return {
        source: existingSourceHandle,
        sink: existingSinkHandle
      };
    }

    let takesMore = true;
    let finishing = false;
    let finished = false;
    let paused = true;
    let ended = false;

    const stream = factory.open({
      next: ({ chunks }) => {
        handleNext({ source: selfSource, chunks });
      },

      end: () => {
        ended = true;
        maybeFinishSome();
      },

      drain: () => {
        takesMore = true;
        maybePauseOrResume();
      },

      fail: ({ error }) => {
        handleFail({ error });
      }
    });

    let sourceDestroyed = false;
    let sinkDestroyed = false;

    const maybeDestroyStream = () => {
      if (sourceDestroyed && sinkDestroyed) {
        stream.destroy();
      }
    };

    const selfSource: IInternalSourceHandle = {
      factory,

      pause: () => {
        paused = true;
        stream.pause();
      },

      resume: () => {
        paused = false;
        stream.resume();
      },

      destroy: () => {
        sourceDestroyed = true;
        maybeDestroyStream();
      },

      status: () => {
        return {
          paused,
          ended
        };
      }
    };

    const selfSink: IInternalSinkHandle = {
      factory,

      write: ({ chunks }) => {
        const result = stream.write({ chunks });

        if (!result.takesMore && takesMore === true) {
          takesMore = false;
          maybePauseOrResume();
        }
      },

      finish: () => {
        finishing = true;
        stream.finish({
          done: () => {
            finished = true;
            maybePipelineDone();
          }
        });
      },

      destroy: () => {
        sinkDestroyed = true;
        maybeDestroyStream();
      },

      status: () => {
        return {
          takesMore,
          finishing,
          finished
        };
      }
    };

    internalSourceHandles = [
      ...internalSourceHandles,
      selfSource
    ];

    internalSinkHandles = [
      ...internalSinkHandles,
      selfSink
    ];

    return {
      source: selfSource,
      sink: selfSink
    };
  };

  let started = false;
  let destroyed = false;

  let callbacks: IPipelineNetworkFactoryStreamArgs | undefined = undefined;

  const findAllInternalSources = () => {
    let allSources: IInternalSourceHandle[] = [];

    connections.forEach((conn) => {
      if (!allSources.includes(conn.source)) {
        allSources = [
          ...allSources,
          conn.source
        ];
      }
    });

    return allSources;
  };

  const findAllInternalSinks = () => {
    let allSinks: IInternalSinkHandle[] = [];

    connections.forEach((conn) => {
      if (!allSinks.includes(conn.sink)) {
        allSinks = [
          ...allSinks,
          conn.sink
        ];
      }
    });

    return allSinks;
  };

  const findAllConnectedInternalSinks = ({ source: providedSource }: { source: IInternalSourceHandle }) => {
    return connections.filter((conn) => {
      return conn.source === providedSource;
    }).map((conn) => {
      return conn.sink;
    });
  };

  const maybePipelineDone = () => {
    const allSinks = findAllInternalSinks();

    const allSinksFinished = allSinks.every((internalSink) => {
      return internalSink.status().finished;
    });

    if (allSinksFinished) {
      callbacks!.done();
    }
  };

  const maybePauseOrResume = () => {
    const allSources = findAllInternalSources();

    allSources.forEach((internalSource) => {
      const connectedSinks = findAllConnectedInternalSinks({ source: internalSource });

      const allSinksTakeMore = connectedSinks.every((connectedSink) => {
        return connectedSink.status().takesMore;
      });

      const sourceStatus = internalSource.status();
      const paused = sourceStatus.paused;

      if (paused && allSinksTakeMore) {
        internalSource.resume();
      } else if (!paused && !allSinksTakeMore) {
        internalSource.pause();
      }
    });
  };

  const findTargetStreamsOfSource = ({ source: providedSource }: { source: IInternalSourceHandle }) => {
    const targetConnections = connections.filter((conn) => {
      return conn.source === providedSource;
    });

    const targets = targetConnections.map((conn) => {
      return conn.sink;
    });

    let targetsDeduped: IInternalSinkHandle[] = [];
    targets.forEach((target) => {
      if (!targetsDeduped.includes(target)) {
        targetsDeduped = [
          ...targetsDeduped,
          target
        ];
      }
    });

    return targetsDeduped;
  };

  const findSourceStreamsOfSink = ({ sink: providedSink }: { sink: IInternalSinkHandle }) => {
    const relevantConnections = connections.filter((conn) => {
      return conn.sink === providedSink;
    });

    const sources = relevantConnections.map((conn) => {
      return conn.source;
    });

    return sources;
  };

  type TGenericRewireWiring = IRewireWiring<TStreamChunk, TStreamChunk, TStreamChunk, TStreamChunk>;

  let initialWirings: TGenericRewireWiring[] = [];

  const rewire: IRewireablePipelineNetworkFactory["rewire"] = ({ wirings }) => {

    // @ts-expect-error TODO: how to do this gracefully?
    const wiringsGeneric = wirings as TGenericRewireWiring[];

    if (!started) {
      initialWirings = wiringsGeneric;
      return;
    }

    let newConnections: IInternalConnection[] = [];

    wiringsGeneric.forEach((wiring) => {
      if (wiring.via.length === 0) {
        newConnections = [
          ...newConnections,
          {
            source: maybeCreateSourceHandle({ source: wiring.from }),
            sink: maybeCreateSinkHandle({ factory: wiring.to })
          }
        ];

        return;
      }

      let sourceHandle: IInternalSourceHandle = maybeCreateSourceHandle({ source: wiring.from });

      wiring.via.forEach((factory) => {
        const duplexHandle = maybeCreateDuplexHandle({ factory });

        newConnections = [
          ...newConnections,
          {
            source: sourceHandle,
            sink: duplexHandle.sink
          }
        ];

        sourceHandle = duplexHandle.source;
      });

      newConnections = [
        ...newConnections,
        {
          source: sourceHandle,
          sink: maybeCreateSinkHandle({ factory: wiring.to })
        }
      ];
    });

    connections = newConnections;

    maybePauseOrResume();

    // TODO: remove old handles
  };

  const stream: IPipelineNetworkFactory["stream"] = ({ done: providedDone, failed }) => {

    if (started) {
      throw Error("pipeline network already started");
    }

    callbacks = {
      done: providedDone,
      failed
    };

    started = true;
    rewire({ wirings: initialWirings });

    return {
      destroy: () => {
        destroyed = true;

        let allHandles: IInternalHandle[] = [];

        connections.forEach((conn) => {
          if (!allHandles.includes(conn.source)) {
            allHandles = [
              ...allHandles,
              conn.source
            ];
          }

          if (!allHandles.includes(conn.sink)) {
            allHandles = [
              ...allHandles,
              conn.sink
            ];
          }
        });

        allHandles.forEach((handle) => {
          handle.destroy();
        });
      }
    };
  };

  return {
    rewire,
    stream
  };
};

const createLinear = ({
  from,
  via,
  to
}: {
  from: ISourceStreamFactory<TStreamChunk>,
  via: IDuplexStreamFactory<TStreamChunk, TStreamChunk>[],
  to: ISinkStreamFactory<TStreamChunk>
}) => {
  const pn = create();

  pn.rewire({
    wirings: [
      {
        from,
        via,
        to
      }
    ]
  });

  return pn;
};


type TPipelineSourceOpenFunc<T extends TStreamChunk> = (args: { output: ISinkStreamFactory<T> }) => IPipelineNetworkFactory;


const pipelineSource = <T extends TStreamChunk>({
  open
}: {
  open: TPipelineSourceOpenFunc<T>
}): ISourceStreamFactory<T> => {

  return {
    open: ({ next, end, fail }) => {

      let paused = false;
      let started = false;
      let needsDrain = false;

      let outputDrain: (() => void) | undefined = undefined;

      const output = sink<T>({
        open: ({ drain }) => {
          outputDrain = drain;

          return {
            write: ({ chunks }) => {
              if (!started) {
                throw Error("write before first resume, expected, please implement");
              }

              next({ chunks });

              const takesMore = !paused;
              if (!takesMore) {
                needsDrain = true;
              }

              return {
                takesMore
              };
            },

            finish: ({ done }) => {
              console.log("virtual pipeline sink finished");
              done();
            },

            destroy: () => {
              // unused
            }
          };
        }
      });

      const pipelineNetwork = open({
        output
      });

      let pipelineNetworkStream: IPipelineNetworkStream | undefined = undefined;

      return {
        pause: () => {
          paused = true;
        },

        resume: () => {
          started = true;
          paused = false;

          if (pipelineNetworkStream === undefined) {
            pipelineNetworkStream = pipelineNetwork.stream({
              done: () => {
                // unused
                end();
              },

              failed: ({ error }) => {
                fail({ error });
              }
            });
          }

          if (needsDrain) {
            needsDrain = false;
            outputDrain!();
          }
        },

        destroy: () => {
          if (pipelineNetworkStream !== undefined) {
            pipelineNetworkStream.destroy();
          }
        }
      };
    }
  };
};

type TPipelineSinkOpenFunc <T extends TStreamChunk> = (args: { input: ISourceStreamFactory<T> }) => IPipelineNetworkFactory;

const pipelineSink = <T extends TStreamChunk>({
  open
}: {
  open: TPipelineSinkOpenFunc<T>
}): ISinkStreamFactory<T> => {
  return sink({
    open: ({ drain, fail }) => {

      let started = false;
      let paused = true;
      let needsDrain = false;

      let sourceNext: ((args: { chunks: T[] }) => void) | undefined = undefined;
      let sourceEnd: (() => void) | undefined = undefined;

      const input = source<T>({
        open: ({ next, end }) => {

          sourceNext = next;
          sourceEnd = end;

          return {
            pause: () => {
              paused = true;
            },

            resume: () => {
              started = true;
              paused = false;

              if (needsDrain) {
                needsDrain = false;
                drain();
              }
            },

            destroy: () => {
              // unused
            }
          };
        }
      });

      const pipelineNetwork = open({
        input
      });

      let doneCallback: (() => void) | undefined = undefined;

      const pipelineNetworkStream = pipelineNetwork.stream({
        done: () => {
          doneCallback!();
        },

        failed: ({ error }) => {
          fail({ error });
        }
      });

      return {
        write: ({ chunks }) => {
          if (!started) {
            throw Error("BUG: write before first resume, expected, please implement");
          }

          sourceNext!({ chunks });

          const takesMore = !paused;
          if (!takesMore) {
            needsDrain = true;
          }

          return {
            takesMore
          };
        },

        finish: ({ done }) => {
          doneCallback = done;
          sourceEnd!();
        },

        destroy: () => {
          if (pipelineNetworkStream !== undefined) {
            pipelineNetworkStream.destroy();
          }
        }
      };
    }
  });
};

type TPipelineTransformOpenFunc<T extends TStreamChunk, U extends TStreamChunk> = (args: {
  input: ISourceStreamFactory<T>,
  output: ISinkStreamFactory<U>
}) => IPipelineNetworkFactory;

const pipelineTransform = <T extends TStreamChunk, U extends TStreamChunk>({ open }: { open: TPipelineTransformOpenFunc<T, U> }) => {
  return duplex<T, U>({
    open: ({ drain: duplexDrain, next: duplexNext, end: duplexEnd, fail: duplexFail }) => {

      let duplexStarted = false;
      let duplexPaused = true;
      let duplexNeedsDrain = false;

      let virtualOutputNeedsDrain = false;
      let virtualOutputDrain: (() => void) | undefined = undefined;

      let virtualInputPaused = true;
      let virtualInputNext: ((args: { chunks: T[] }) => void) | undefined = undefined;
      let virtualInputEnd: (() => void) | undefined = undefined;

      const input = source<T>({
        open: ({ next, end }) => {

          virtualInputNext = next;
          virtualInputEnd = end;

          return {
            pause: () => {
              virtualInputPaused = true;
            },

            resume: () => {
              virtualInputPaused = false;

              if (duplexNeedsDrain) {
                duplexNeedsDrain = false;
                duplexDrain();
              }
            },

            destroy: () => {
              // unused
            }
          };
        }
      });

      const output = sink<U>({
        open: ({ drain }) => {
          virtualOutputDrain = drain;

          return {
            write: ({ chunks }) => {
              if (!duplexStarted) {
                throw Error("write before first resume, expected, please implement");
              }

              duplexNext({ chunks });

              const takesMore = !duplexPaused;
              if (!takesMore) {
                virtualOutputNeedsDrain = true;
              }

              return {
                takesMore
              };
            },

            finish: ({ done }) => {
              console.log("virtual pipeline sink finished");
              done();
            },

            destroy: () => {
              // unused
            }
          };
        }
      });

      const pipelineNetwork = open({
        input,
        output
      });

      let doneCallback: (() => void) | undefined = undefined;

      const pipelineNetworkStream = pipelineNetwork.stream({
        done: () => {
          duplexEnd();
          doneCallback!();
        },

        failed: ({ error }) => {
          duplexFail({ error });
        }
      });

      return {
        write: ({ chunks }) => {
          if (!duplexStarted) {
            throw Error("BUG: write before first resume, expected, please implement");
          }

          virtualInputNext!({ chunks });

          const takesMore = !virtualInputPaused;
          if (!takesMore) {
            duplexNeedsDrain = true;
          }

          return {
            takesMore
          };
        },

        finish: ({ done }) => {
          doneCallback = done;
          virtualInputEnd!();
        },

        pause: () => {
          duplexPaused = true;
        },

        resume: () => {
          duplexStarted = true;
          duplexPaused = false;

          if (virtualOutputNeedsDrain) {
            virtualOutputNeedsDrain = false;
            virtualOutputDrain!();
          }
        },

        destroy: () => {
          if (pipelineNetworkStream !== undefined) {
            pipelineNetworkStream.destroy();
          }
        }
      };
    }
  });
};

const chain = <SourceChunk extends TStreamChunk>({ from }: { from: ISourceStreamFactory<SourceChunk> }) => {

  const via = <T extends TStreamChunk> ({ transform }: { transform: IDuplexStreamFactory<SourceChunk, T> }) => {

    const end = ({ to }: { to: ISinkStreamFactory<T> }) => {
    };

    return {
      end
    };
  };

  return {
    via
  };
};

export {
  create,
  createLinear,

  pipelineSource,
  pipelineSink,
  pipelineTransform,

  chain
};
