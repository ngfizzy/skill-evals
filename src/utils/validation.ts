export function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

export function parseChoice<T extends string>(value: string, allowed: readonly T[]): T {
  const choice = allowed.find((candidate) => candidate === value);
  if (choice === undefined) throw new Error(`Expected one of ${allowed.join(', ')}; got ${value}`);
  return choice;
}

export function parsePositiveInteger(value: string, name: string, maximum: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0 || number > maximum)
    throw new Error(`${name} must be a positive integer of at most ${maximum}`);
  return number;
}

export function mapping(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a mapping in eval metadata');
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected an array in eval metadata');
  return value;
}

export function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a nonempty string');
  return value;
}

export function strings(value: unknown): string[] {
  return array(value).map(nonempty);
}
