import type {
  TSinkStreamWriteTransaction,
  TSinkStreamWriteTransactionStatus
} from "./sink-stream.ts";

type TStreamPressureGauge<X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus> = {
  // adds a transaction to the ones the gauge keeps track of
  report: (args: { transaction: TSinkStreamWriteTransaction<X> }) => void;

  // returns the reported transactions that are still pending, the others are removed from the gauge
  pending: () => readonly TSinkStreamWriteTransaction<X>[];
};

// keeps track of the pending transactions of a stream, e.g. to limit how many of them may be in flight
const createStreamPressureGauge = <
  X extends TSinkStreamWriteTransactionStatus = TSinkStreamWriteTransactionStatus
>(): TStreamPressureGauge<X> => {
  let transactions: readonly TSinkStreamWriteTransaction<X>[] = [];

  const report: TStreamPressureGauge<X>["report"] = ({ transaction }) => {
    transactions = [...transactions, transaction];
  };

  const pending = () => {
    transactions = transactions.filter((transaction) => {
      return transaction.status().type === "pending";
    });

    return transactions;
  };

  return {
    report,
    pending
  };
};

export type {
  TStreamPressureGauge
};

export {
  createStreamPressureGauge
};
