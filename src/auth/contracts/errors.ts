export const AUTH_ERROR_CODES = [
  'invalid-store',
  'cleanup-required',
  'login-required',
  'invalid-credentials',
  'lock-timeout',
  'lock-failed',
  'unsupported-runtime',
  'operation-failed',
  'interrupted',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(messages[code]);
    this.name = 'AuthError';
  }
}

const messages: Record<AuthErrorCode, string> = {
  'cleanup-required':
    'Authentication cleanup could not be verified. Stop any surviving operation and finish cleanup before reusing the evaluation store.',
  'invalid-store': 'The evaluation credential store failed its ownership or identity checks.',
  'login-required': 'Sign in with ChatGPT to set up the evaluation login.',
  'invalid-credentials':
    'The evaluation store must contain a valid ChatGPT login, without an API key.',
  'lock-timeout': 'Timed out waiting for the evaluation credential store.',
  'lock-failed': 'Could not acquire the evaluation credential lock.',
  'unsupported-runtime':
    'Authentication requires the audited Bun and Codex runtime on a supported platform.',
  'operation-failed':
    'The authentication operation failed. No credentials were included in diagnostics.',
  interrupted: 'Authentication was interrupted.',
};
