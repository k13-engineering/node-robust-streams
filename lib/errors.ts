type ErrorFactory = ((args: { message: string }) => globalThis.Error) & { isInstance: (err: object) => boolean };

// @ts-expect-error workaround
const boostrap: ErrorFactory = {};

const makeError = (nameObject: object): ErrorFactory => {
  const name = Object.keys(nameObject)[0];

  const weakSetInstances = new WeakSet();

  const errorFactory = ({ message }: { message: string }) => {
    const err = Error(message);
    err.name = name;
    weakSetInstances.add(err);
    return err;
  };

  errorFactory.isInstance = (err: object) => {
    return weakSetInstances.has(err);
  };

  return errorFactory;
};

let StreamAlreadyDestroyedError = boostrap;
StreamAlreadyDestroyedError = makeError({ StreamAlreadyDestroyedError });

let StreamAlreadyFailedError = boostrap;
StreamAlreadyFailedError = makeError({ StreamAlreadyFailedError });

let StreamAlreadyFinishingError = boostrap;
StreamAlreadyFinishingError = makeError({ StreamAlreadyFinishingError });

let StreamAlreadyFinishedError = boostrap;
StreamAlreadyFinishedError = makeError({ StreamAlreadyFinishedError });

let StreamAlreadyEndedError = boostrap;
StreamAlreadyEndedError = makeError({ StreamAlreadyEndedError });

let StreamAlreadyOpenedError = boostrap;
StreamAlreadyOpenedError = makeError({ StreamAlreadyOpenedError });

let StreamAlreadyPausedError = boostrap;
StreamAlreadyPausedError = makeError({ StreamAlreadyPausedError });

let StreamNotPausedError = boostrap;
StreamNotPausedError = makeError({ StreamNotPausedError });

let StreamReentrancyError = boostrap;
StreamReentrancyError = makeError({ StreamReentrancyError });

let StreamResumeDuringNextError = boostrap;
StreamResumeDuringNextError = makeError({ StreamResumeDuringNextError });

let StreamDrainDuringWriteError = boostrap;
StreamDrainDuringWriteError = makeError({ StreamDrainDuringWriteError });

let StreamCallbackDuringPauseError = boostrap;
StreamCallbackDuringPauseError = makeError({ StreamCallbackDuringPauseError });

let StreamDuplexLoopError = boostrap;
StreamDuplexLoopError = makeError({ StreamDuplexLoopError });

export {
  StreamAlreadyDestroyedError,
  StreamAlreadyFailedError,
  StreamAlreadyFinishingError,
  StreamAlreadyFinishedError,
  StreamAlreadyEndedError,
  StreamAlreadyOpenedError,
  StreamAlreadyPausedError,
  StreamNotPausedError,
  StreamReentrancyError,
  StreamResumeDuringNextError,
  StreamDrainDuringWriteError,
  StreamCallbackDuringPauseError,
  StreamDuplexLoopError,
};
