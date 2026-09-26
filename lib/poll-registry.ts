import type { TPollHandle, TPollHandleStatus } from "./poll.ts";

const PENDING: TPollHandleStatus = Object.freeze({ type: "pending" });
const TRIGGERED: TPollHandleStatus = Object.freeze({ type: "triggered" });
const CANCELLED: TPollHandleStatus = Object.freeze({ type: "cancelled" });

type TPollRegistry = {
  // registers a poll, if ready is true, the poll is triggered without waiting for notify()
  poll: (args: { onUpdate: () => void; ready: boolean }) => TPollHandle;

  // triggers all polls registered so far, the triggering happens asynchronously in a later task
  notify: () => void;
};

// helper for stream implementations to fulfill the poll contract:
//  - onUpdate is never called synchronously, every poll is triggered in its own later task
//  - multiple polls may be pending, each of them is triggered
//  - exceptions thrown from onUpdate are not caught
const createPollRegistry = (): TPollRegistry => {
  let waiting: readonly (() => void)[] = [];

  const poll: TPollRegistry["poll"] = ({ onUpdate, ready }) => {
    let status: TPollHandleStatus = PENDING;

    const trigger = () => {
      if (status !== PENDING) {
        return;
      }

      status = TRIGGERED;
      onUpdate();
    };

    // a later task instead of a microtask, so a consumer polling again right away can not starve IO
    const schedule = () => {
      setTimeout(trigger, 0);
    };

    const cancel = () => {
      status = CANCELLED;
      waiting = waiting.filter((entry) => {
        return entry !== schedule;
      });
    };

    if (ready) {
      schedule();
    } else {
      waiting = [...waiting, schedule];
    }

    return {
      status: () => {
        return status;
      },
      cancel
    };
  };

  const notify = () => {
    const toSchedule = waiting;
    waiting = [];

    toSchedule.forEach((schedule) => {
      schedule();
    });
  };

  return {
    poll,
    notify
  };
};

export type {
  TPollRegistry
};

export {
  createPollRegistry
};
