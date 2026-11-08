import type { Criterion } from '../evaluation/index.ts';

export interface Skill {
  path: string;
  requires: string[];
}

export interface EvalSource {
  path: string;
  hash: string;
}

export interface CaseDraft {
  id: unknown;
  title: unknown;
  prompt: unknown;
  assertions: Criterion[];
  references: unknown;
}
