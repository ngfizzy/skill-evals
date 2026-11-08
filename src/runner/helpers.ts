import type { Catalog } from '../catalog/index.ts';
import type { EvaluationCase, PreparedCase } from '../evaluation/index.ts';

import type { Options } from './types.ts';

export async function prepareCases(
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
