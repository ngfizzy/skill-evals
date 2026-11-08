import type { CaseResult, EvaluationPhase } from '../evaluation/index.ts';
import type { Options } from '../runner/index.ts';
import type { Summary } from '../report/index.ts';

/** Presentation-only state names. They never feed grading, reports or exit codes. */
export type CaseState = 'passed' | 'failed' | 'error' | 'running' | 'pending' | 'not-run';
export type RunState = 'running' | 'finished' | 'interrupted' | 'incomplete';
export type Tone = 'accent' | 'pass' | 'fail' | 'error' | 'muted';

export interface StatusStyle {
  icon: string;
  label: string;
  tone: Tone;
}

// Every icon is paired with a word so neither color nor symbol carries meaning alone.
// Glyphs are single-width in common terminal fonts; emoji-presentation symbols are avoided.
export const CASE_STATUS: Record<CaseState, StatusStyle> = {
  passed: { icon: '✓', label: 'PASSED', tone: 'pass' },
  failed: { icon: '✗', label: 'FAILED', tone: 'fail' },
  error: { icon: '▲', label: 'ERROR', tone: 'error' },
  running: { icon: '◐', label: 'RUNNING', tone: 'accent' },
  pending: { icon: '○', label: 'PENDING', tone: 'muted' },
  'not-run': { icon: '◌', label: 'NOT RUN', tone: 'muted' },
};

export function caseState(
  key: string,
  result: CaseResult | undefined,
  current: { key: string } | undefined,
  finished: boolean,
): CaseState {
  if (result) return result.status;
  if (finished) return 'not-run';
  return current?.key === key ? 'running' : 'pending';
}

export function runState(
  finished: boolean,
  interrupted: boolean | undefined,
  finishedAt: string | undefined,
  pending: number,
): RunState {
  if (!finished) return 'running';
  if (interrupted) return 'interrupted';
  if (!finishedAt || pending) return 'incomplete';
  return 'finished';
}

export function runStatus(
  state: RunState,
  summary: Pick<Summary, 'failed' | 'errors'>,
): StatusStyle {
  switch (state) {
    case 'running':
      return { icon: '◐', label: 'RUNNING', tone: 'accent' };
    case 'interrupted':
      return { icon: '■', label: 'INTERRUPTED', tone: 'error' };
    case 'incomplete':
      return { icon: '◌', label: 'INCOMPLETE', tone: 'error' };
    case 'finished':
      return {
        icon: '●',
        label: 'FINISHED',
        tone: summary.errors ? 'error' : summary.failed ? 'fail' : 'pass',
      };
  }
}

export function phaseLabel(phase: EvaluationPhase | undefined): string {
  return phase === 'judge' ? 'grader reviewing' : 'operator responding';
}

/** Completed cases only: no token, time or partial-case progress is inferred. */
export function progressCells(
  done: number,
  total: number,
  width: number,
): { filled: number; empty: number } {
  const cells = Math.max(0, Math.floor(width));
  if (!total) return { filled: 0, empty: cells };
  const filled = Math.min(cells, Math.floor((cells * Math.min(done, total)) / total));
  return { filled, empty: cells - filled };
}

export function formatElapsed(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${String(value % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function criteriaMet(
  result: CaseResult | undefined,
): { met: number; total: number } | undefined {
  if (!result?.assertions || result.status === 'error') return undefined;
  return {
    met: result.assertions.filter((item) => item.passed).length,
    total: result.assertions.length,
  };
}

export function colorEnabled(
  option: Options['color'],
  environment: Record<string, string | undefined>,
): boolean {
  return (
    option === 'always' ||
    (option === 'auto' && !environment.NO_COLOR && environment.TERM !== 'dumb')
  );
}

/** `unknown` means the terminal did not report its background; nothing may assume one. */
export type ThemeMode = 'dark' | 'light' | 'unknown';

/** Body text keeps the terminal's own foreground; the palette only marks owned chrome and states.
 * Fills always come with their own foreground (selectedBg/selectedFg, alertBg/alertFg). */
export interface Palette {
  accent?: string;
  pass?: string;
  fail?: string;
  error?: string;
  muted?: string;
  rule?: string;
  quote?: string;
  selectedBg?: string;
  selectedFg?: string;
  alertBg?: string;
  alertFg?: string;
}

// Status and accent colors keep at least 4.5:1 against the selected-row fill of their own theme.
const DARK: Required<Palette> = {
  accent: '#82aaff',
  pass: '#5fd38d',
  fail: '#ff7b7b',
  error: '#e8b04b',
  muted: '#9aa2b4',
  rule: '#3d4556',
  quote: '#56607a',
  selectedBg: '#25324a',
  selectedFg: '#f2f5fa',
  alertBg: '#5b2128',
  alertFg: '#ffe3e3',
};
const LIGHT: Required<Palette> = {
  accent: '#1d5bbf',
  pass: '#116329',
  fail: '#a40e26',
  error: '#7d4e00',
  muted: '#5b6170',
  rule: '#c3c8d2',
  quote: '#9aa3b5',
  selectedBg: '#dbe6f7',
  selectedFg: '#0f1a2e',
  alertBg: '#fbe0e0',
  alertFg: '#5a0d12',
};
// Unreported background: mid-tones near relative luminance 0.18 reach 4.5:1 on both black and white,
// and no fills are used, so selection falls back to the marker and bold default-foreground text.
const UNKNOWN: Palette = {
  accent: '#286ef0',
  pass: '#00883c',
  fail: '#e61e1e',
  error: '#c85000',
  muted: '#767676',
  rule: '#767676',
  quote: '#767676',
  alertFg: '#e61e1e',
};

export function palette(color: boolean, mode: ThemeMode): Palette {
  if (!color) return {};
  return mode === 'light' ? LIGHT : mode === 'dark' ? DARK : UNKNOWN;
}

export function toneColor(colors: Palette, tone: Tone): string | undefined {
  return colors[tone];
}
