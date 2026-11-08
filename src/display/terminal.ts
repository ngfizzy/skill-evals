import { singleLine } from '../utils/index.ts';
import type { ReportCheckpoint } from '../report/index.ts';
import type { CaseResult, EvaluationCase, EvaluationPhase } from '../evaluation/index.ts';
import type { Options } from '../runner/index.ts';

import type { TerminalIO } from './types.ts';
import { formatCaseResult, paint } from './output.ts';

export class TerminalRenderer {
  private readonly started = Date.now();
  private readonly outColor: boolean;
  private readonly errColor: boolean;
  private readonly live: boolean;
  private readonly plain: boolean;
  private readonly width: number;
  private checkpoint: Pick<ReportCheckpoint, 'results' | 'selected_cases'> = {
    results: [],
    selected_cases: 0,
  };
  private current: { key: string; phase: EvaluationPhase } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private readonly fullInput: boolean;

  constructor(
    private readonly io: TerminalIO,
    options: Pick<Options, 'color' | 'progress' | 'width'> & { fullInput?: boolean },
  ) {
    this.fullInput = options.fullInput ?? false;
    const capabilities = io.terminal;
    const environment = capabilities?.environment ?? {};
    const autoColor = !environment.NO_COLOR && environment.TERM !== 'dumb';

    this.outColor =
      options.color === 'always' ||
      (options.color === 'auto' && !!capabilities?.stdoutTTY && autoColor);
    this.errColor =
      options.color === 'always' ||
      (options.color === 'auto' && !!capabilities?.stderrTTY && autoColor);

    this.live =
      options.progress === 'auto' && !!capabilities?.stderrTTY && environment.TERM !== 'dumb';
    this.plain =
      options.progress === 'plain' || (options.progress === 'auto' && !!capabilities && !this.live);
    this.width = options.width ?? (capabilities?.stdoutTTY ? capabilities.columns : Infinity);
  }

  start(report: ReportCheckpoint, path: string): void {
    this.checkpoint = report;
    this.io.out(paint('skill-evals · response-only evaluation', 36, this.outColor));
    this.io.out(
      `Operator: ${singleLine(report.model)} · Grader: ${singleLine(report.judge_model)}`,
    );
    this.io.out(
      `Selected: ${report.selected_cases} case(s) · Protocol: ${report.evaluation_protocol}`,
    );
    this.io.out(`Report: ${singleLine(path)}`);
  }

  phase(entry: EvaluationCase, phase: EvaluationPhase): void {
    this.current = { key: singleLine(entry.key), phase };
    if (this.plain) this.io.err(this.status(false));
    if (this.live) {
      this.draw();
      this.timer ??= setInterval(() => this.draw(), 100);
      this.timer.unref();
    }
  }

  caseSaved(result: Readonly<CaseResult>, checkpoint: ReportCheckpoint): void {
    this.clear();
    this.checkpoint = checkpoint;
    this.current = undefined;

    for (const line of formatCaseResult(result, this.outColor, this.width, this.fullInput))
      this.io.out(line);
    this.io.out('');
  }

  finish(report: ReportCheckpoint): void {
    this.dispose();

    const { summary } = report;
    if (report.interrupted)
      this.io.out(paint('INTERRUPTED · partial report saved', 33, this.outColor));

    const parts = [
      paint(`${summary.passed} passed`, 32, this.outColor),
      paint(`${summary.failed} failed`, 31, this.outColor),
      paint(`${summary.errors} errors`, 35, this.outColor),
      `${summary.pending} pending`,
    ];
    this.io.out(`${parts.join(', ')}; assertion score=${summary.assertion_score ?? 'unscored'}`);
    this.io.out(
      `${report.results.length}/${report.selected_cases} cases recorded · errors are not scored`,
    );
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }

  private status(animated: boolean): string {
    const { results, selected_cases: selected } = this.checkpoint;
    const completed = results.length;
    const phase = this.current?.phase === 'candidate' ? 'operator' : 'grader';
    const elapsed = Math.floor((Date.now() - this.started) / 1000);
    const marker = animated ? ['|', '/', '-', '\\'][this.frame++ % 4]! + ' ' : '';
    let text = `${marker}${completed}/${selected} complete · case ${completed + 1}/${selected} ${this.current?.key ?? ''} · ${phase} running · ${elapsed}s`;

    const columns = this.io.terminal?.columns ?? 80;
    if (animated && Bun.stringWidth(text) > columns - 1)
      text = `${marker}${completed}/${selected} complete · ${phase} · ${elapsed}s`;
    if (animated && Bun.stringWidth(text) > columns - 1) text = `${completed}/${selected} ${phase}`;
    return text;
  }

  private draw(): void {
    if (this.current)
      this.io.terminal?.writeStatus(`\r\u001b[2K${paint(this.status(true), 36, this.errColor)}`);
  }

  private clear(): void {
    if (this.live) this.io.terminal?.writeStatus('\r\u001b[2K');
  }
}
