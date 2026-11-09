import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { temporary } from './fixture.ts';

export async function gitServer(t: TestContext) {
  const root = await temporary(t);
  const home = join(root, 'home');
  const snapshots = join(root, 'snapshots');
  const project = join(root, 'repos');
  await Promise.all(
    [home, snapshots, join(project, 'team')].map((path) => mkdir(path, { recursive: true })),
  );

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: snapshots,
  };
  const isolated = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

  const key = join(root, 'key.pem');
  const cert = join(root, 'cert.pem');
  const config = join(root, 'openssl.cnf');
  await writeFile(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n' +
      '[dn]\nCN=127.0.0.1\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1\n',
  );
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      config,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    root,
    isolated,
  );
  const configure = (key: string, value: string): void => {
    run('git', ['config', '--file', join(home, '.gitconfig'), '--add', key, value], root, isolated);
  };
  configure('http.sslCAInfo', cert);

  const requests: { path: string; authenticated: boolean }[] = [];
  let pendingRequest: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    pendingRequest = resolve;
  });
  let releaseRequest: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: await readFile(key), cert: await readFile(cert) },
    async fetch(request) {
      const url = new URL(request.url);
      const authenticated = request.headers.get('authorization') === AUTHORIZATION;
      requests.push({ path: url.pathname, authenticated });

      if (url.pathname.startsWith('/team/stall.git/')) {
        pendingRequest?.();
        await release;
        return new Response('released', { status: 503 });
      }
      if (url.pathname.startsWith('/team/redirect.git/'))
        return Response.redirect(
          new URL(url.pathname.replace('/redirect.git/', '/trap.git/'), url),
          302,
        );
      if (url.pathname.startsWith('/team/trap.git/')) return new Response('trap', { status: 404 });

      const privatePath = url.pathname.startsWith('/team/private.git/');
      if (privatePath && !authenticated)
        return new Response('auth required', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="fixture"' },
        });

      const path = privatePath
        ? url.pathname.replace('/private.git/', '/skills.git/')
        : url.pathname;
      return gitResponse(request, url, path, project, isolated);
    },
  });
  t.after(() => {
    releaseRequest?.();
    server.stop(true);
  });

  return {
    root,
    env,
    requests,
    stalled,
    configure,
    url(name = 'skills') {
      return `https://127.0.0.1:${server.port}/team/${name}.git`;
    },
    async repository(name = 'skills') {
      const work = join(root, name);
      const bare = join(project, 'team', `${name}.git`);
      await mkdir(work);
      const git = (...args: string[]): string =>
        run(
          'git',
          ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
          work,
          isolated,
        );
      git('init', '-q', '-b', 'main');
      git('init', '-q', '--bare', '-b', 'main', bare);
      return {
        work,
        git,
        publish(stage?: () => void) {
          git('add', '-A');
          stage?.();
          git('commit', '-qm', 'Synthetic fixture');
          git('push', '-q', '--tags', bare, 'HEAD:refs/heads/main');
          return git('rev-parse', 'HEAD');
        },
        pushTag(tag: string) {
          git('tag', '-a', tag, '-m', tag);
          git('push', '-q', '--tags', bare);
        },
      };
    },
    async assertClean() {
      assert.deepEqual(await readdir(snapshots), []);
    },
  };
}

async function gitResponse(
  request: Request,
  url: URL,
  path: string,
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  const input = await request.arrayBuffer();
  const child = Bun.spawn(['git', 'http-backend'], {
    stdin: new Uint8Array(input),
    stdout: 'pipe',
    stderr: 'ignore',
    env: {
      ...env,
      GIT_PROJECT_ROOT: project,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: path,
      REQUEST_METHOD: request.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(input.byteLength),
      HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
      HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
    },
  });
  const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
  assert.equal(await child.exited, 0);
  const separator = Buffer.from('\r\n\r\n');
  const index = output.indexOf(separator);
  assert.ok(index >= 0, 'Git CGI output has headers');

  let status = 200;
  const headers = new Headers();
  for (const line of output.subarray(0, index).toString().split('\r\n')) {
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'status') status = Number.parseInt(value, 10);
    else headers.append(key, value);
  }
  return new Response(output.subarray(index + separator.length), { status, headers });
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export const FIXTURE_SECRET = 'synthetic-credential-secret';
const AUTHORIZATION = `Basic ${Buffer.from(`fixture:${FIXTURE_SECRET}`).toString('base64')}`;
