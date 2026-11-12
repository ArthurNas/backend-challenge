export function immutableSnapshot<T extends object>(value: T): Readonly<T> {
  const snapshot = structuredClone(value);

  freezeChildren(snapshot);

  return snapshot;
}

function freezeChildren(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;

  for (const child of Object.values(value)) freezeChildren(child);

  Object.freeze(value);
}
