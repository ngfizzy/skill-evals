import type { AuthErrorCode } from './errors.ts';

export const AUTH_OPERATIONS = ['login', 'status', 'logout'] as const;
export const AUTH_STATES = ['signed-in', 'signed-out'] as const;

export type AuthOperation = (typeof AUTH_OPERATIONS)[number];
export type AuthState = (typeof AUTH_STATES)[number];

export type AuthEvent =
  | { type: 'login-url'; url: string }
  | { type: 'state'; state: AuthState }
  | { type: 'error'; code: AuthErrorCode };

export interface AuthOperationOptions {
  signal?: AbortSignal;
  onEvent?: (event: AuthEvent) => void;
}

export interface AuthStoreLocation {
  directory: string;
  authFile: string;
  normalDirectory: string;
}

export interface CredentialLease {
  readonly fd: number;
  release(): Promise<void>;
}

export interface AuthLauncherRequest {
  operation: AuthOperation;
  store: AuthStoreLocation;
  nativeExecutable: string;
  timeoutMs: number;
  lockWaitMs: number;
  workspace: string;
}
