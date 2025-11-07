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

