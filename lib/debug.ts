const ELogLevel = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  ERROR: "ERROR"
} as const;

type TELogLevel = typeof ELogLevel[keyof typeof ELogLevel];

interface ILogger {
  log: (args: { level: TELogLevel, message: string }) => void;
};

export type {
  ILogger,
  TELogLevel
};

export {
  ELogLevel
};
