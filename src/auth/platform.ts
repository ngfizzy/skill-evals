import { AuthError } from './errors.ts';

// Authentication runs only on the Bun runtime that was audited for credential isolation.
export const AUDITED_BUN_VERSION = '1.4.4';

export interface SupportedPlatform {
  os: 'darwin' | 'linux';
  arch: 'arm64' | 'x64';
  codexTarget: string;
}

const CODEX_TARGETS: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

export function supportedPlatform(): SupportedPlatform {
  const key = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(CODEX_TARGETS, key)) throw new AuthError('unsupported-runtime');

  return {
    os: process.platform as SupportedPlatform['os'],
    arch: process.arch as SupportedPlatform['arch'],
    codexTarget: CODEX_TARGETS[key]!,
  };
}
