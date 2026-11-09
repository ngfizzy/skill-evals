import { GitSkillRoot, type GitSnapshot } from './git.ts';
import { LocalSkillRoot } from './local.ts';
import type { GitSource, RootInput, SkillRoot } from './types.ts';

export async function resolveRoots(
  inputs: readonly RootInput[],
  signal: AbortSignal,
): Promise<ResolvedRoots> {
  const roots: SkillRoot[] = [];
  const snapshots: GitSnapshot[] = [];

  const dispose = async (): Promise<void> => {
    const results = await Promise.allSettled(snapshots.map((snapshot) => snapshot.dispose()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  };

  try {
    for (const input of inputs) {
      signal.throwIfAborted();
      if (input.kind === 'local') {
        roots.push(await LocalSkillRoot.open(input.directory, signal));
      } else {
        const snapshot = await GitSkillRoot.open(input, signal);
        snapshots.push(snapshot);
        roots.push(snapshot.root);
      }
    }

    return { roots, gitSources: snapshots.map((snapshot) => snapshot.provenance), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export interface ResolvedRoots {
  readonly roots: readonly SkillRoot[];
  readonly gitSources: readonly GitSource[];
  dispose(): Promise<void>;
}
