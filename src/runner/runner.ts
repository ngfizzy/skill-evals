import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { CodexAgent } from '../adaptors/index.ts';
import { Catalog } from '../catalog/index.ts';
import { selectRunDisplay, type RunDisplay } from '../display/index.ts';
import { EvaluationOrchestrator, EvaluationRunner, PROTOCOL_VERSION } from '../evaluation/index.ts';
import { Judge } from '../judge/index.ts';
import { Operator } from '../operator/index.ts';
import { readReport, ReportWriter, withSummary } from '../report/index.ts';
import { message, singleLine } from '../utils/index.ts';

import { consoleIO } from './console-io.ts';
import { HELP } from './help.ts';
import { prepareCases } from './helpers.ts';
import { parseOptions } from './options.ts';
import type { Options, RunIO } from './types.ts';

export class Run {
  constructor(private readonly io: RunIO = consoleIO) {}

  async execute(args: string[], signal?: AbortSignal): Promise<number> {
    try {
      const options = parseOptions(args);
      if (options.help) return this.help();

      // Read-only commands: inspect a report or list matching cases.
      if (options.view) return await this.viewSavedReport(options.view, options, signal);
      if (options.list) return await this.listCases(options);

      return await this.runEvaluations(options, signal);
    } catch (error) {
      this.io.err(`Skill eval error: ${singleLine(message(error))}`);
      return 2;
    }
  }

  private help(): number {
    this.io.out(HELP);
    return 0;
  }

  private async viewSavedReport(
    path: string,
    options: Options,
    signal = new AbortController().signal,
  ): Promise<number> {
    const openDisplay = selectRunDisplay(options, this.io, () => {}, signal);
    const report = await readReport(path);

    const display = await openDisplay({
      initialCheckpoint: report,
      entries: report.results,
      path,
      replay: true,
    });

    try {
      await display.finish(report);
      return signal.aborted ? 2 : 0;
    } catch (error) {
      await this.disposeAfterFailure(display);
      throw error;
    }
  }

  private async listCases(options: Options): Promise<number> {
    const catalog = await Catalog.load(options.roots);
    const selected = catalog.select(options);

    for (const entry of selected) this.io.out(`${entry.key}\t${entry.title}`);
    this.io.out(`${selected.length} case(s); no agent calls.`);
    return 0;
  }

  private async runEvaluations(options: Options, signal?: AbortSignal): Promise<number> {
    const { io } = this;
    const catalog = await Catalog.load(options.roots);
    const selected = catalog.select(options);

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    let display: RunDisplay | undefined;
    try {
      if (!options.model) throw new Error('Live runs require --model MODEL');
      const openDisplay = selectRunDisplay(options, io, abort, controller.signal);
      const preparedCases = await prepareCases(catalog, selected, options.context);

      const adapter = io.createAgent?.(options) ?? new CodexAgent(options.codex, options.timeout);
      await adapter.preflight(controller.signal);

      const operatorSettings = { model: options.model, effort: options.effort };
      const judgeSettings = {
        model: options.judgeModel ?? options.model,
        effort: options.judgeEffort,
      };

      const initialCheckpoint = withSummary({
        ...REPORT_DEFAULTS,
        started_at: new Date().toISOString(),
        agent_version: adapter.version,
        model: operatorSettings.model,
        judge_model: judgeSettings.model,
        context: options.context,
        reasoning_effort: operatorSettings.effort,
        judge_reasoning_effort: judgeSettings.effort,
        timeout_seconds: options.timeout,
        selected_cases: selected.length,
        results: [],
      });

      const output =
        options.output ?? join(process.cwd(), '.eval-runs', `${Date.now()}-${randomUUID()}.json`);
      const writer = await ReportWriter.create(output, initialCheckpoint);

      const runDisplay = await openDisplay({
        initialCheckpoint,
        entries: selected,
        path: writer.path,
        bundles: new Map(preparedCases.map(({ entry, bundle }) => [entry.key, bundle])),
      });
      display = runDisplay;

      const orchestrator = new EvaluationOrchestrator({
        operator: new Operator(adapter, operatorSettings),
        judge: new Judge(adapter, judgeSettings),
      });
      const runner = new EvaluationRunner({
        orchestrator,
        writer,
        display: runDisplay,
      });

      const finalReport = await runner.run({
        cases: preparedCases,
        initialCheckpoint,
        signal: controller.signal,
      });

      const { summary } = finalReport;
      await runDisplay.finish(finalReport);

      if (summary.errors || summary.pending || finalReport.interrupted) return 2;
      return summary.failed ? 1 : 0;
    } catch (error) {
      await this.disposeAfterFailure(display);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private async disposeAfterFailure(display: RunDisplay | undefined): Promise<void> {
    try {
      await display?.dispose();
    } catch (error) {
      this.io.err(`Terminal cleanup error: ${singleLine(message(error))}`);
    }
  }
}

export function run(args: string[], io: RunIO = consoleIO, signal?: AbortSignal): Promise<number> {
  return new Run(io).execute(args, signal);
}

const REPORT_DEFAULTS = {
  version: 1,
  mode: 'response-only',
  evaluation_protocol: PROTOCOL_VERSION,
} as const;
