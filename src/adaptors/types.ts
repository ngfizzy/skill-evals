export interface AgentRequest {
  model: string;
  schema?: object;
  effort?: string;
  signal?: AbortSignal;
}

export interface Agent {
  version: string;
  preflight(signal?: AbortSignal): Promise<void>;
  call(prompt: string, request: AgentRequest): Promise<string>;
}

export interface ModelSettings {
  model: string;
  effort: string;
}
