export class ProcessTeardownError extends Error {}

export type SupervisedOutcome =
  { code: number | null; signal: NodeJS.Signals | null } | { error: 'spawn' | 'teardown' };

export interface ProcessOptions {
  input: string;
  timeoutMs: number;
  directory: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  outputLimits?: { stdout: number; stderr: number };
  onStdout?: (chunk: Buffer) => void;
  termination?: 'process-group' | 'leader';
}
