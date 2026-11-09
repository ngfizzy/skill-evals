import type { Criterion } from '../evaluation/index.ts';
import type { SkillRoot } from '../sources/index.ts';

export interface Skill {
  root: SkillRoot;
  requires: string[];
}

export interface CatalogLoadOptions {
  readonly loadSkills?: readonly string[];
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
