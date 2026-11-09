import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ProcessTimeoutError, runProcess } from '../process/index.ts';

import type { GitRootInput } from './types.ts';

type GitConfigEntry = readonly [key: string, value: string];

interface GitRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export class GitCommand {
  private readonly trustedEnv = gitEnvironment();
  private readonly isolatedEnv = {
    ...this.trustedEnv,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  private readonly hooks: string;

  constructor(
    private readonly executable: string,
    private readonly directory: string,
    private readonly origin: string,
    private readonly signal: AbortSignal,
  ) {
    this.hooks = join(directory, 'empty-hooks');
  }

  async fetch({ url, revision }: GitRootInput): Promise<void> {
    await this.run('initialization', ['init', '--bare', '--template=']);
    await mkdir(this.hooks);
    if (revision.startsWith('refs/')) {
      await this.run('revision validation', ['check-ref-format', revision]);
    }

    const env = await this.fetchEnvironment(url);
    await this.run(
      'fetch',
      [
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-auto-gc',
        '--no-write-commit-graph',
        '--',
        url,
        revision,
      ],
      { env, timeoutMs: 60_000 },
    );
  }

  async run(stage: string, args: string[], options: GitRunOptions = {}): Promise<string> {
    try {
      return await runProcess([this.executable, ...args], {
        directory: this.directory,
        signal: this.signal,
        input: '',
        timeoutMs: options.timeoutMs ?? 10_000,
        env: options.env ?? this.isolatedEnv,
        outputLimits: { stdout: options.maxBytes ?? 65_536, stderr: 65_536 },
      });
    } catch (error) {
      // Git and trusted credential helpers can include credentials in diagnostics.
      if (this.signal.aborted) throw new Error('Git source loading interrupted');
      const outcome = error instanceof ProcessTimeoutError ? 'timed out' : 'failed';
      throw new Error(`Git ${stage} ${outcome} for ${this.origin}`);
    }
  }

  private async fetchEnvironment(url: string): Promise<NodeJS.ProcessEnv> {
    const trusted = { env: this.trustedEnv };
    const expanded = await this.run('URL check', ['ls-remote', '--get-url', '--', url], trusted);
    if (expanded !== `${url}\n`) throw new Error(`Git URL rewrite rejected for ${url}`);

    const config = await this.run(
      'authentication configuration',
      ['config', '--null', '--includes', '--list'],
      trusted,
    );
    const settings: GitConfigEntry[] = [
      ...authenticationSettings(config),
      ['credential.interactive', 'false'],
      ['core.hooksPath', this.hooks],
      ['http.followRedirects', 'false'],
      ['http.sslVerify', 'true'],
    ];

    const env: NodeJS.ProcessEnv = {
      ...this.isolatedEnv,
      GIT_CONFIG_COUNT: String(settings.length),
    };
    for (const [index, [key, value]] of settings.entries()) {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    }
    return env;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !EXTERNAL_OVERRIDES.test(key)),
  );
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
}

function authenticationSettings(config: string): GitConfigEntry[] {
  const settings: GitConfigEntry[] = [];
  for (const entry of config.split('\0')) {
    const split = entry.indexOf('\n');
    const key = split < 0 ? entry : entry.slice(0, split);
    if (AUTH_CONFIG.test(key)) settings.push([key, split < 0 ? 'true' : entry.slice(split + 1)]);
  }
  return settings;
}

const EXTERNAL_OVERRIDES =
  /^(?:GIT_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|CURL_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR|SSH_ASKPASS|BASH_ENV|ENV)$/i;
const AUTH_CONFIG =
  /^(?:credential\.(?:.*\.)?(?:helper|username|usehttppath)|http\.(?:.*\.)?sslca(?:info|path))$/u;
