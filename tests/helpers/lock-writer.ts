// Increments a counter in the credentials file under the lock. A lost update means the lock failed.
// Usage: lock-writer.ts <store-location-json> <increments>
import { readFile, writeFile } from 'node:fs/promises';

import { CredentialLock } from '../../src/auth/lock.ts';
import type { AuthStoreLocation } from '../../src/auth/types.ts';

const store = JSON.parse(process.argv[2]!) as AuthStoreLocation;
const increments = Number(process.argv[3]);

for (let i = 0; i < increments; i++) {
  const lease = await CredentialLock.acquire(store);
  try {
    const data = JSON.parse(await readFile(store.authFile, 'utf8'));
    // Widen the read-modify-write window so an unlocked writer would interleave.
    await Bun.sleep(1);
    data.counter++;
    await writeFile(store.authFile, JSON.stringify(data));
  } finally {
    await lease.release();
  }
}
