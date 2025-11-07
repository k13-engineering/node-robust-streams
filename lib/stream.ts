interface IStreamFactory {

};

interface IStream {
  destroy: (args?: { reason?: string }) => void;
};

type TStreamChunk = NonNullable<unknown>;
type TStreamError = globalThis.Error;
type TStreamBackpressureFunc = (args: { pressure: number }) => void;
type TStreamFailFunc = (args: { error: TStreamError }) => void;
type TStreamDestroyFunc = (args: { reason: string }) => void;

export type {
  IStreamFactory,
  IStream,
  TStreamChunk,
  TStreamError,
  TStreamBackpressureFunc,
  TStreamFailFunc,
  TStreamDestroyFunc
};
