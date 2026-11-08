import { parseArgs } from 'node:util';

import { parseChoice, parsePositiveInteger } from '../utils/index.ts';

import type { Options } from './types.ts';

export function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      root: { type: 'string', multiple: true },
      skill: { type: 'string', multiple: true },
      case: { type: 'string', multiple: true },
      limit: { type: 'string' },
      timeout: { type: 'string' },
      model: { type: 'string' },
      'judge-model': { type: 'string' },
      codex: { type: 'string' },
      context: { type: 'string' },
      effort: { type: 'string' },
      'judge-effort': { type: 'string' },
      output: { type: 'string' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      color: { type: 'string' },
      progress: { type: 'string' },
      width: { type: 'string' },
      ui: { type: 'string' },
      view: { type: 'string' },
      'full-input': { type: 'boolean' },
    },
  });

  for (const value of Object.values(values).flat()) {
    if (typeof value === 'string' && !value.trim()) throw new Error('Option must not be empty');
  }

  const evaluationOptions = [
    'root',
    'skill',
    'case',
    'model',
    'judge-model',
    'codex',
    'output',
    'list',
    'limit',
    'timeout',
    'context',
    'effort',
    'judge-effort',
  ] as const;
  if (values.view && evaluationOptions.some((key) => values[key] !== undefined)) {
    throw new Error('--view accepts display options only; it never runs evaluations');
  }

  return {
    roots: values.root?.length ? values.root : [process.cwd()],
    skills: values.skill ?? [],
    cases: values.case ?? [],
    limit: parsePositiveInteger(values.limit ?? '5', 'limit', MAX_NUMERIC_OPTION),
    timeout: parsePositiveInteger(values.timeout ?? '120', 'timeout', MAX_NUMERIC_OPTION),
    context: parseChoice(values.context ?? 'full', ['full', 'focused']),
    effort: parseChoice(values.effort ?? 'low', REASONING_EFFORTS),
    judgeEffort: parseChoice(values['judge-effort'] ?? 'low', REASONING_EFFORTS),
    list: values.list ?? false,
    help: values.help ?? false,
    color: parseChoice(values.color ?? 'auto', ['auto', 'always', 'never']),
    progress: parseChoice(values.progress ?? 'auto', ['auto', 'plain', 'none']),
    ui: parseChoice(values.ui ?? 'auto', ['auto', 'interactive', 'plain']),
    fullInput: values['full-input'] ?? false,
    ...(values.view ? { view: values.view } : {}),
    ...(values.width
      ? { width: parsePositiveInteger(values.width, 'width', MAX_NUMERIC_OPTION) }
      : {}),
    ...(values.codex ? { codex: values.codex } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values['judge-model'] ? { judgeModel: values['judge-model'] } : {}),
    ...(values.output ? { output: values.output } : {}),
  };
}

const MAX_NUMERIC_OPTION = 2_147_483;
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
