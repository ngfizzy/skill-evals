import type { Agent } from '../adaptors/index.ts';
import type { TerminalIO } from '../display/index.ts';

export interface Options {
  roots: string[];
  loadSkills: string[];
  skills: string[];
  cases: string[];
  limit: number;
  timeout: number;
  codex?: string;
  model?: string;
  judgeModel?: string;
  output?: string;
  context: 'full' | 'focused';
  effort: string;
  judgeEffort: string;
  list: boolean;
  help: boolean;
  color: 'auto' | 'always' | 'never';
  progress: 'auto' | 'plain' | 'none';
  width?: number;
  ui: 'auto' | 'interactive' | 'plain';
  fullInput: boolean;
  view?: string;
}

export interface RunIO extends TerminalIO {
  createAgent?(options: Options): Agent;
}
