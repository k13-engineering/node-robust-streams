type TStreamChunk = Record<string, unknown>;
type TBinaryStreamChunk = {
  data: Uint8Array;
};

// immutability rules:
//  - every object handed over by or to a stream (e.g. chunk arrays, chunks, read results, statuses)
//    MUST NOT be mutated afterwards by anyone, including everything it references (recursively)

// exception rules:
//  - exceptions signal bugs (e.g. contract violations) and are meant to crash the process, catching them is a smell
//  - streams MUST NOT catch exceptions thrown by their users, including those thrown from within onUpdate
//  - errors of the underlying IO (e.g. a throwing fs.readSync() or a rejected promise) are no bugs,
//    they MUST be caught where they occur and be reported through the failing status, not thrown

export type {
  TStreamChunk,
  TBinaryStreamChunk
};
