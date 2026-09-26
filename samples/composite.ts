// helpers to derive the status of a stream composed of child streams

type TStatusTypes = readonly string[];

const allIn = ({ types, allowed }: { types: TStatusTypes; allowed: TStatusTypes }) => {
  return types.every((type) => {
    return allowed.includes(type);
  });
};

const anyIn = ({ types, allowed }: { types: TStatusTypes; allowed: TStatusTypes }) => {
  return types.some((type) => {
    return allowed.includes(type);
  });
};

// a composite that tears down only enters its final status once all children are final
const whenAllFinal = <S>({
  types,
  finalTypes,
  final,
  busy
}: {
  types: TStatusTypes;
  finalTypes: TStatusTypes;
  final: S;
  busy: S;
}): S => {
  return allIn({ types, allowed: finalTypes }) ? final : busy;
};

export {
  allIn,
  anyIn,
  whenAllFinal
};
