import { Catalog } from '../catalog/index.ts';
import type { EvaluationCase, PreparedCase } from '../evaluation/index.ts';
import { parseRootInput, resolveRoots, type GitSource } from '../sources/index.ts';

import type { Options } from './types.ts';

export async function withCatalog<T>(
  options: Options,
  signal: AbortSignal,
  useCatalog: (catalog: Catalog, gitSources: readonly GitSource[]) => T | Promise<T>,
): Promise<T> {
  const sources = await resolveRoots(options.roots.map(parseRootInput), signal);
  let value: T;

  try {
    const catalog = await Catalog.load(sources.roots, { loadSkills: options.loadSkills });
    value = await useCatalog(catalog, sources.gitSources);
  } finally {
    await sources.dispose();
  }

  signal.throwIfAborted();
  return value;
}

export function prepareRun(options: Options, signal: AbortSignal): Promise<PreparedRun> {
  return withCatalog(options, signal, async (catalog, gitSources) => {
    const selected = catalog.select(options);
    const cases = await prepareCases(catalog, selected, options.context);
    return { selected, cases, gitSources };
  });
}

interface PreparedRun {
  readonly selected: EvaluationCase[];
  readonly cases: PreparedCase[];
  readonly gitSources: readonly GitSource[];
}

async function prepareCases(
  catalog: Catalog,
  entries: EvaluationCase[],
  mode: Options['context'],
): Promise<PreparedCase[]> {
  const prepared: PreparedCase[] = [];

  for (const entry of entries) {
    const references = mode === 'focused' ? entry.references : undefined;
    const bundle = await catalog.bundle(entry.skill, references);

    prepared.push({
      entry,
      bundle,
      contextMetadata: {
        context_mode: mode === 'focused' && references === undefined ? 'full-fallback' : mode,
        context_bytes: Buffer.byteLength(bundle),
      },
    });
  }

  return prepared;
}
