import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { AUDITED_CODEX_VERSION } from '../../adaptors/codex-helpers.ts';
import { AuthError } from '../contracts/errors.ts';

import { supportedPlatform } from './platform.ts';

// Resolve the native executable, rather than the JS launcher that drops extra fds.
export function packagedAuthRuntime(): string {
  const { os, arch, codexTarget } = supportedPlatform();

  try {
    const require = createRequire(import.meta.url);
    const cli = require.resolve('@openai/codex/package.json');
    const native = createRequire(cli).resolve(`@openai/codex-${os}-${arch}/package.json`);

    if (packageVersion(native) !== `${AUDITED_CODEX_VERSION}-${os}-${arch}`)
      throw new AuthError('unsupported-runtime');

    return join(dirname(native), 'vendor', codexTarget, 'bin', 'codex');
  } catch {
    throw new AuthError('unsupported-runtime');
  }
}

function packageVersion(path: string): unknown {
  const metadata: unknown = JSON.parse(readFileSync(path, 'utf8'));

  return metadata && typeof metadata === 'object' && 'version' in metadata
    ? metadata.version
    : undefined;
}
