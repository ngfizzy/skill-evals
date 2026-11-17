import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CredentialLock } from '../../src/auth/lock.ts';

const [store, writes] = process.argv.slice(2);
const lease = await CredentialLock.acquire(JSON.parse(store!), undefined, 10_000);
try {
  const before = await readFile(writes!, 'utf8');
  await Bun.sleep(150);
  assert.equal(
    await readFile(writes!, 'utf8'),
    before,
    'A native descendant wrote during the next lease',
  );
} finally {
  await lease.release();
}
