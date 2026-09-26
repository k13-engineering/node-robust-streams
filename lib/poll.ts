type TPollHandleStatus = {
  type: "pending"
} | {
  type: "triggered"
} | {
  type: "cancelled"
};

// allowed status transitions:
//  - pending -> triggered
//  - pending -> cancelled

type TPollHandle = {
  // MUST yield the same result until either:
  //  - cancel() is called
  //  - the stream that created this handle triggers it, which MUST happen asynchronously
  // i.e. if you repeatedly call status() and nothing else, the result MUST NOT change
  // the returned object MUST NOT be modified afterwards, it MAY be a new object on every call
  // MUST already yield triggered when onUpdate is called
  status: () => TPollHandleStatus;

  // MUST NOT be called in:
  //  - status triggered
  //  - status cancelled
  cancel: () => void;
};

export type {
  TPollHandle,
  TPollHandleStatus
};
