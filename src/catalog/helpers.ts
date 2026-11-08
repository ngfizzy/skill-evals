import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parseDocument } from 'yaml';

import type { Criterion } from '../evaluation/index.ts';
import { array, containedPath, mapping, strings } from '../utils/index.ts';

export function criteria(values: unknown, required: boolean): Criterion[] {
  return strings(values).map((text) => ({ id: '', text, required }));
}

export function parseYaml(content: string): unknown {
  const document = parseDocument(content, { schema: 'core', uniqueKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error(
      `Invalid YAML: ${[...document.errors, ...document.warnings].map((error) => error.message).join('; ')}`,
    );
  }

  return document.toJS({ maxAliasCount: 0 });
}

export async function referenceFiles(
  directory: string,
  owner: string,
  seen = new Set<string>(),
  budget = { count: 0 },
): Promise<string[]> {
  const real = await containedPath(directory, owner);
  if (seen.has(real)) throw new Error(`Reference directory cycle: ${directory}`);
  seen.add(real);

  const result: string[] = [];
  for (const name of (await readdir(real)).sort()) {
    if (++budget.count > 10_000) throw new Error('Too many reference entries');
    const path = join(directory, name);
    const target = await containedPath(path, owner);
    if ((await stat(target)).isDirectory())
      result.push(...(await referenceFiles(path, owner, seen, budget)));
    else if (name.endsWith('.md')) result.push(path);
  }

  return result.sort();
}

export function jsonCriteria(evaluation: Record<string, unknown>): Criterion[] {
  if (!('criteria' in evaluation))
    return criteria([evaluation.expected_output, ...array(evaluation.assertions ?? [])], true);
  if ('expected_output' in evaluation || 'assertions' in evaluation)
    throw new Error('Explicit criteria cannot be combined with legacy rubric fields');

  const explicit = mapping(evaluation.criteria);
  if (Object.keys(explicit).some((key) => key !== 'must' && key !== 'must_not'))
    throw new Error('Unknown criteria field');
  return [...criteria(explicit.must ?? [], true), ...criteria(explicit.must_not ?? [], false)];
}

export async function validateReference(reference: string, owner: string): Promise<void> {
  if (
    !/^references\/.+\.md$/.test(reference) ||
    reference.includes('\\') ||
    reference.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`Invalid reference path: ${reference}`);
  }

  const path = await containedPath(join(owner, reference), owner);
  if (!(await stat(path)).isFile())
    throw new Error(`Reference must be a regular file: ${reference}`);
}
