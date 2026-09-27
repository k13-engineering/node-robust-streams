type TNoProperties = Record<never, never>;

// a report is required as soon as its properties are non-empty, so the status it ends up in never lacks them,
// i.e. a stream either reports status properties from all functions producing that status or from none of them
type TStatusReport<P extends object> = [keyof P] extends [never] ? { status?: P | undefined } : { status: NoInfer<P> };

// the report types require a report whenever its properties are non-empty, so {} only stands in for no properties
const statusOf = <P extends object>({ report }: { report: { status?: P } }): P => {
  return report.status ?? ({} as P);
};

export type {
  TNoProperties,
  TStatusReport
};

export {
  statusOf
};
