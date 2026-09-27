import { violation } from "./guard.ts";
import type { TSinkStreamStatus } from "./sink-stream.ts";
import type { TSourceStreamStatus } from "./source-stream.ts";

// assertion functions take the status positionally, as typescript can only narrow a parameter, not a property of it

type TAssertSourceStatusNotDestroyed = <S extends TSourceStreamStatus>(
  status: S
) => asserts status is Exclude<S, { type: "destroyed" }>;

type TAssertSinkStatusNotDestroyed = <S extends TSinkStreamStatus>(
  status: S
) => asserts status is Exclude<S, { type: "destroyed" }>;

const assertNotDestroyed = ({ name, status }: { name: string; status: { type: string } }) => {
  if (status.type === "destroyed") {
    throw violation({ message: `${name} status MUST NOT be destroyed` });
  }
};

// throws a contract violation if the source status is destroyed, afterwards typescript knows that it is not destroyed
const assertSourceStatusNotDestroyed: TAssertSourceStatusNotDestroyed = (status) => {
  assertNotDestroyed({ name: "source", status });
};

// throws a contract violation if the sink status is destroyed, afterwards typescript knows that it is not destroyed
const assertSinkStatusNotDestroyed: TAssertSinkStatusNotDestroyed = (status) => {
  assertNotDestroyed({ name: "sink", status });
};

// the statuses in which a transition to a final or the open status is in progress
const SOURCE_IN_PROGRESS = ["opening", "ending", "failing", "destroying"] as const;
const SINK_IN_PROGRESS = ["opening", "finishing", "failing", "destroying"] as const;

type TSourceStreamInProgressStatus = { type: typeof SOURCE_IN_PROGRESS[number] };
type TSinkStreamInProgressStatus = { type: typeof SINK_IN_PROGRESS[number] };

type TAssertSourceStatusNotInProgress = <S extends TSourceStreamStatus>(
  status: S
) => asserts status is Exclude<S, TSourceStreamInProgressStatus>;

type TAssertSinkStatusNotInProgress = <S extends TSinkStreamStatus>(
  status: S
) => asserts status is Exclude<S, TSinkStreamInProgressStatus>;

const assertNotInProgress = ({
  name,
  status,
  inProgress
}: {
  name: string;
  status: { type: string };
  inProgress: readonly string[];
}) => {
  if (inProgress.includes(status.type)) {
    throw violation({ message: `${name} status MUST NOT be in progress (${inProgress.join(", ")}), but is ${status.type}` });
  }
};

// throws a contract violation if the source status is opening, ending, failing or destroying,
// afterwards typescript knows that it is none of them
const assertSourceStatusNotInProgress: TAssertSourceStatusNotInProgress = (status) => {
  assertNotInProgress({ name: "source", status, inProgress: SOURCE_IN_PROGRESS });
};

// throws a contract violation if the sink status is opening, finishing, failing or destroying,
// afterwards typescript knows that it is none of them
const assertSinkStatusNotInProgress: TAssertSinkStatusNotInProgress = (status) => {
  assertNotInProgress({ name: "sink", status, inProgress: SINK_IN_PROGRESS });
};

export type {
  TAssertSinkStatusNotDestroyed,
  TAssertSinkStatusNotInProgress,
  TAssertSourceStatusNotDestroyed,
  TAssertSourceStatusNotInProgress,
  TSinkStreamInProgressStatus,
  TSourceStreamInProgressStatus
};

export {
  assertSinkStatusNotDestroyed,
  assertSinkStatusNotInProgress,
  assertSourceStatusNotDestroyed,
  assertSourceStatusNotInProgress
};
