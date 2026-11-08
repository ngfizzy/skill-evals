import type { RunIO } from './types.ts';

export const consoleIO: RunIO = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  terminal: {
    stdoutTTY: !!process.stdout.isTTY,
    stderrTTY: !!process.stderr.isTTY,
    stdinTTY: !!process.stdin.isTTY,
    columns: process.stderr.columns || process.stdout.columns || 80,
    environment: process.env,
    writeStatus: (text) => {
      process.stderr.write(text);
    },
  },
};
