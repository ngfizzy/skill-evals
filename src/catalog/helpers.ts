import { parseDocument } from 'yaml';

import type { Criterion } from '../evaluation/index.ts';
import type { SkillRoot } from '../sources/index.ts';
import { array, mapping, strings } from '../utils/index.ts';

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
  root: SkillRoot,
  directory: string,
  seen = new Set<string>(),
  budget = { count: 0 },
): Promise<string[]> {
  const { identity, names } = await root.list(directory);
  if (seen.has(identity)) throw new Error(`Reference directory cycle: ${root.source(directory)}`);
  seen.add(identity);

  const result: string[] = [];
  for (const name of [...names].sort()) {
    if (++budget.count > 10_000) throw new Error('Too many reference entries');
    const path = `${directory}/${name}`;
    const kind = await root.kind(path);
    if (kind === 'missing') throw new Error(`Missing reference entry: ${root.source(path)}`);
    if (kind === 'directory') result.push(...(await referenceFiles(root, path, seen, budget)));
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

export async function validateReference(root: SkillRoot, reference: string): Promise<void> {
  if (
    !MARKDOWN_REFERENCE_PATH_PATTERN.test(reference) ||
    reference.includes('\\') ||
    reference.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`Invalid reference path: ${reference}`);
  }

  if ((await root.kind(reference)) !== 'file')
    throw new Error(`Reference must be a regular file: ${reference}`);
}

export function validateSkillName(name: string): void {
  if (
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    SKILL_NAME_SEPARATOR_OR_CONTROL_PATTERN.test(name)
  )
    throw new Error('Skill names must be single directory components');
}

const MARKDOWN_REFERENCE_PATH_PATTERN = /^references\/.+\.md$/;
const SKILL_NAME_SEPARATOR_OR_CONTROL_PATTERN = /[/\\\x00-\x1f\x7f]/;
