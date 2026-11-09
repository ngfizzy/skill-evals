export interface ProcessOptions {
  input: string;
  timeoutMs: number;
  directory: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  outputLimits?: { stdout: number; stderr: number };
}
