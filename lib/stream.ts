interface IStreamFactory {

};

interface IStream {
  destroy: (args?: { reason?: string }) => void;
};

type TStreamChunk = NonNullable<unknown>;

type TStreamError = globalThis.Error;

export type {
  IStreamFactory,
  IStream,
  TStreamChunk,
  TStreamError
};
