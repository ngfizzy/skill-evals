// Acquires the credential lock in a separate process, prints READY, and holds it until killed.
// Usage: lock-holder.ts <store-location-json>
import { CredentialLock } from '../../src/auth/lock.ts';
import type { AuthStoreLocation } from '../../src/auth/types.ts';

const store = JSON.parse(process.argv[2]!) as AuthStoreLocation;
const lease = await CredentialLock.acquire(store);

console.log('READY');
setInterval(() => void lease.fd, 1000);
