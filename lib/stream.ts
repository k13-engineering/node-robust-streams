interface IStreamFactory {

};

interface IStream {
  destroy: (args?: { reason?: string }) => void;
};

type TStreamChunk = object | string;

type TStreamError = globalThis.Error;

export type {
  IStreamFactory,
  IStream,
  TStreamChunk,
  TStreamError
};
