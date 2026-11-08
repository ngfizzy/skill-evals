import type { CaseResult, EvaluationCase, EvaluationPhase } from '../evaluation/index.ts';
import type { ReportCheckpoint } from '../report/index.ts';
import type { Options } from '../runner/index.ts';

export interface RunDisplay {
  phase(entry: Readonly<EvaluationCase>, phase: EvaluationPhase): void;
  caseSaved(result: Readonly<CaseResult>, checkpoint: ReportCheckpoint): void;
  finish(finalCheckpoint: ReportCheckpoint): Promise<void>;
  dispose(): Promise<void>;
}

export type DisplayOptions = Pick<Options, 'ui' | 'color' | 'progress' | 'width' | 'fullInput'>;

export interface DisplayInput {
  initialCheckpoint: ReportCheckpoint;
  entries: readonly Readonly<EvaluationCase>[];
  path: string;
  bundles?: ReadonlyMap<string, string>;
  replay?: boolean;
}

export interface ViewSnapshot {
  report: ReportCheckpoint;
  entries: readonly Readonly<EvaluationCase>[];
  path: string;
  finished: boolean;
  current?: { key: string; phase: EvaluationPhase };
  bundles?: ReadonlyMap<string, string>;
}

export interface TerminalIO {
  out(text: string): void;
  err(text: string): void;
  terminal?: TerminalCapabilities;
}

export interface TerminalCapabilities {
  stdinTTY?: boolean;
  stdoutTTY: boolean;
  stderrTTY: boolean;
  columns: number;
  environment: Record<string, string | undefined>;
  writeStatus(text: string): void;
}

/** `placeholder` marks owned explanatory text, so views can style it apart from recorded content. */
export interface ResultSection {
  id: string;
  title: string;
  text: string;
  collapsed: boolean;
  placeholder?: boolean;
}

/** One validated criterion verdict. `evidence` is the saved quote verbatim; `note` explains an empty quote. */
export interface VerdictItem {
  id: string;
  text: string;
  required: boolean;
  passed: boolean;
  reason: string;
  evidence?: string;
  note?: string;
}
