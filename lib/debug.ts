enum ELogLevel {
  DEBUG,
  INFO,
  ERROR
};

interface ILogger {
  log: (args: { level: ELogLevel, message: string }) => void;
};

export type {
  ILogger
};

export {
  ELogLevel
};
