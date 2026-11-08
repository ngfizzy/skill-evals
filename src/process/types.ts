export interface ProcessOptions {
  input: string;
  timeoutMs: number;
  directory: string;
  signal?: AbortSignal;
}
