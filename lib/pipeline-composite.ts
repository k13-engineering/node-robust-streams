import { sink, type TSinkStreamFactory } from "./sink.ts";
import { source, type TSourceStreamFactory } from "./source.ts";
import { duplex, type TDuplexStreamFactory } from "./duplex.ts";
import { createPipelineNetwork, pipeline, type TPipelineNetwork } from "./pipeline.ts";
import type { TStreamBackpressureFunc, TStreamChunk } from "./stream.ts";

type TPipelineSourceOpenFunc<T extends TStreamChunk> = (args: { output: TSinkStreamFactory<T> }) => TPipelineNetwork;

const pipelineSource = <T extends TStreamChunk>({
  open
}: {
  open: TPipelineSourceOpenFunc<T>
}): TSourceStreamFactory<T> => {

  return source<T>({
    openSourceStream: ({ next, end, fail }) => {

      let outputBackpressure: TStreamBackpressureFunc | undefined = undefined;
      let outputFinished = false;

      const output = sink<T>({
        openSinkStream: ({ backpressure }) => {
          outputBackpressure = backpressure;

          return {
            write: ({ chunks }) => {
              next({ chunks });
            },

            finish: ({ done }) => {
              console.log("virtual pipeline sink finished");
              outputFinished = true;
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

      const pipelineNetworkStream = pipelineNetwork.stream({
        done: () => {
          end();
        },

        failed: ({ error }) => {
          fail({ error });
        }
      });

      return {
        backpressure: ({ pressure }) => {
          // a finished sink does not accept backpressure anymore
          if (outputFinished) {
            return;
          }

          outputBackpressure!({ pressure });
        },

        destroy: () => {
          pipelineNetworkStream.destroy();
        }
      };
    }
  });
};

type TPipelineSinkOpenFunc<T extends TStreamChunk> = (args: { input: TSourceStreamFactory<T> }) => TPipelineNetwork;

const pipelineSink = <T extends TStreamChunk>({
  open
}: {
  open: TPipelineSinkOpenFunc<T>
}): TSinkStreamFactory<T> => {
  return sink<T>({
    openSinkStream: ({ backpressure, fail }) => {

      let sourceNext: ((args: { chunks: T[] }) => void) | undefined = undefined;
      let sourceEnd: (() => void) | undefined = undefined;

      const input = source<T>({
        openSourceStream: ({ next, end }) => {

          sourceNext = next;
          sourceEnd = end;

          return {
            backpressure: ({ pressure }) => {
              backpressure({ pressure });
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
          sourceNext!({ chunks });
        },

        finish: ({ done }) => {
          doneCallback = done;
          sourceEnd!();
        },

        destroy: () => {
          pipelineNetworkStream.destroy();
        }
      };
    }
  });
};

type TPipelineTransformOpenFunc<T extends TStreamChunk, U extends TStreamChunk> = (args: {
  input: TSourceStreamFactory<T>,
  output: TSinkStreamFactory<U>
}) => TPipelineNetwork;

const pipelineTransform = <T extends TStreamChunk, U extends TStreamChunk>({
  open
}: {
  open: TPipelineTransformOpenFunc<T, U>
}): TDuplexStreamFactory<T, U> => {
  return duplex<T, U>({
    openDuplex: ({ next: duplexNext, end: duplexEnd, backpressure: duplexBackpressure, fail: duplexFail }) => {

      let virtualOutputBackpressure: TStreamBackpressureFunc | undefined = undefined;
      let virtualOutputFinished = false;

      let virtualInputNext: ((args: { chunks: T[] }) => void) | undefined = undefined;
      let virtualInputEnd: (() => void) | undefined = undefined;

      const input = source<T>({
        openSourceStream: ({ next, end }) => {

          virtualInputNext = next;
          virtualInputEnd = end;

          return {
            backpressure: ({ pressure }) => {
              duplexBackpressure({ pressure });
            },

            destroy: () => {
              // unused
            }
          };
        }
      });

      const output = sink<U>({
        openSinkStream: ({ backpressure }) => {
          virtualOutputBackpressure = backpressure;

          return {
            write: ({ chunks }) => {
              duplexNext({ chunks });
            },

            finish: ({ done }) => {
              console.log("virtual pipeline sink finished");
              virtualOutputFinished = true;
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
        backpressure: ({ pressure }) => {
          // a finished sink does not accept backpressure anymore
          if (virtualOutputFinished) {
            return;
          }

          virtualOutputBackpressure!({ pressure });
        },

        write: ({ chunks }) => {
          virtualInputNext!({ chunks });
        },

        finish: ({ done }) => {
          doneCallback = done;
          virtualInputEnd!();
        },

        destroy: () => {
          pipelineNetworkStream.destroy();
        }
      };
    }
  });
};

const chain = <SourceChunk extends TStreamChunk>({ from }: { from: TSourceStreamFactory<SourceChunk> }) => {

  const via = <T extends TStreamChunk>({ transform }: { transform: TDuplexStreamFactory<SourceChunk, T> }) => {

    const end = ({ to }: { to: TSinkStreamFactory<T> }): TPipelineNetwork => {
      const network = createPipelineNetwork();

      network.rewire({
        network: [
          pipeline({ from, to: transform }),
          pipeline({ from: transform, to })
        ]
      });

      return network;
    };

    return {
      end
    };
  };

  return {
    via
  };
};

export type {
  TPipelineSourceOpenFunc,
  TPipelineSinkOpenFunc,
  TPipelineTransformOpenFunc
};

export {
  pipelineSource,
  pipelineSink,
  pipelineTransform,
  chain
};
