import { singleLine } from '../utils/index.ts';

import type { ViewSnapshot } from './components/index.ts';
import { TerminalRenderer } from './terminal.ts';
import type { DisplayInput, DisplayOptions, RunDisplay, TerminalIO } from './types.ts';

/** Validate the mode before agent work, and open the display once a report is ready. */
export function selectRunDisplay(
  options: DisplayOptions,
  io: TerminalIO,
  onStop: () => void,
  signal: AbortSignal,
): (input: DisplayInput) => Promise<RunDisplay> {
  const capable =
    !!io.terminal?.stdinTTY && !!io.terminal.stdoutTTY && io.terminal.environment.TERM !== 'dumb';
  if (options.ui === 'interactive' && !capable)
    throw new Error(
      'Interactive UI requires TTY stdin/stdout and TERM other than dumb; use --ui plain',
    );

  return options.ui !== 'plain' && capable
    ? (input) => openInteractiveDisplay(input, options, io, onStop, signal)
    : async (input) => openPlainDisplay(input, options, io);
}

function openPlainDisplay(
  { initialCheckpoint, path, replay }: DisplayInput,
  options: DisplayOptions,
  io: TerminalIO,
): RunDisplay {
  const terminal = new TerminalRenderer(io, options);
  terminal.start(initialCheckpoint, path);

  if (replay)
    for (const result of initialCheckpoint.results) terminal.caseSaved(result, initialCheckpoint);

  return {
    phase: (entry, phase) => terminal.phase(entry, phase),
    caseSaved: (result, checkpoint) => terminal.caseSaved(result, checkpoint),
    async finish(finalCheckpoint) {
      terminal.finish(finalCheckpoint);
    },
    async dispose() {
      terminal.dispose();
    },
  };
}

async function openInteractiveDisplay(
  { initialCheckpoint, entries, path, bundles, replay = false }: DisplayInput,
  options: DisplayOptions,
  io: TerminalIO,
  onStop: () => void,
  signal: AbortSignal,
): Promise<RunDisplay> {
  const { createInteractive } = await import('./interactive.tsx');
  let snapshot: ViewSnapshot = {
    report: initialCheckpoint,
    entries,
    path,
    finished: replay,
    ...(bundles ? { bundles } : {}),
  };

  const session = await createInteractive(snapshot, options, onStop, signal);
  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await session.dispose();
  }

  return {
    phase(entry, phase) {
      snapshot = { ...snapshot, current: { key: entry.key, phase } };
      session.update(snapshot);
    },
    caseSaved(_result, checkpoint) {
      snapshot = { ...snapshot, report: checkpoint };
      session.update(snapshot);
    },
    async finish(finalCheckpoint) {
      if (!replay) session.update({ ...snapshot, report: finalCheckpoint, finished: true });
      await session.wait();
      await dispose();
      if (!replay) io.out(`Report: ${singleLine(path)}`);
      new TerminalRenderer(io, options).finish(finalCheckpoint);
    },
    dispose,
  };
}
