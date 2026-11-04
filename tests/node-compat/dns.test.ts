/**
 * Node.js dns module compatibility tests
 *
 * Adapted from: https://github.com/nodejs/node/blob/main/test/parallel/test-dns-*.js
 *
 * A name is answered by the realm's network namespace's resolver, as its host gives it (`src/network-namespace.ts`),
 * the way a container's names are answered by the resolver its /etc/resolv.conf names. A realm given no namespace
 * has a resolver that holds no name: only literals and `localhost` resolve, and every other name is ENOTFOUND.
 */

import { describe, it, expect } from 'vitest';
import dns, {
  lookup,
  resolve,
  resolve4,
  resolve6,
  reverse,
  setServers,
  getServers,
  setDefaultResultOrder,
  getDefaultResultOrder,
  promises,
  ADDRCONFIG,
  V4MAPPED,
  ALL,
} from '../../src/shims/dns';
import { assert } from './common';
import { getEngineNamespace, loopbackOnlyNamespace, setEngineNamespace, type NetworkNamespace, type ResolverAnswer } from '../../src/network-namespace';

/**
 * A namespace whose resolver holds what Docker's embedded resolver answers a container on one network: `db` and its
 * alias `postgres` at 172.18.0.3 (A only; AAAA is NOERROR with no record), answered a tick later as a host's door is.
 */
function withResolver(): NetworkNamespace {
  const held: Record<string, string[]> = { db: ['172.18.0.3'], postgres: ['172.18.0.3'] };
  return {
    ...loopbackOnlyNamespace(),
    resolve: (name, family) => new Promise<ResolverAnswer>(resolve => setTimeout(() => {
      resolve(held[name] === undefined ? undefined : family === 4 ? held[name] : []);
    }, 0)),
  };
}

/** Asks as a realm of `network` does. */
async function inside<T>(network: NetworkNamespace, ask: () => Promise<T>): Promise<T> {
  const previous = getEngineNamespace();
  setEngineNamespace(network);
  try { return await ask(); } finally { setEngineNamespace(previous); }
}

describe('dns module (Node.js compat)', () => {
  describe('exports', () => {
    it('should export callback API methods', () => {
      expect(typeof lookup).toBe('function');
      expect(typeof resolve).toBe('function');
      expect(typeof resolve4).toBe('function');
      expect(typeof resolve6).toBe('function');
      expect(typeof reverse).toBe('function');
    });

    it('should export server/result-order helpers', () => {
      expect(typeof setServers).toBe('function');
      expect(typeof getServers).toBe('function');
      expect(typeof setDefaultResultOrder).toBe('function');
      expect(typeof getDefaultResultOrder).toBe('function');
    });

    it('should export promises API object', () => {
      expect(typeof promises).toBe('object');
      expect(typeof promises.lookup).toBe('function');
      expect(typeof promises.resolve).toBe('function');
      expect(typeof promises.resolve4).toBe('function');
      expect(typeof promises.resolve6).toBe('function');
      expect(typeof promises.reverse).toBe('function');
    });

    it('should export constants', () => {
      expect(typeof ADDRCONFIG).toBe('number');
      expect(typeof V4MAPPED).toBe('number');
      expect(typeof ALL).toBe('number');
    });
  });

  describe('lookup()', () => {
    it('should resolve localhost to 127.0.0.1', async () => {
      const result = await new Promise<{ address?: string; family?: number }>((resolvePromise) => {
        lookup('localhost', (err, address, family) => {
          expect(err).toBeNull();
          resolvePromise({ address, family });
        });
      });

      assert.strictEqual(result.address, '127.0.0.1');
      assert.strictEqual(result.family, 4);
    });

    it('should resolve 127.0.0.1 as localhost address', async () => {
      const result = await new Promise<{ address?: string; family?: number }>((resolvePromise) => {
        lookup('127.0.0.1', (err, address, family) => {
          expect(err).toBeNull();
          resolvePromise({ address, family });
        });
      });

      assert.strictEqual(result.address, '127.0.0.1');
      assert.strictEqual(result.family, 4);
    });

    it('is ENOTFOUND for a name the namespace\'s resolver does not hold, never a wildcard', async () => {
      const error = await new Promise<NodeJS.ErrnoException | null>((resolvePromise) => {
        lookup('example.com', (err) => resolvePromise(err as NodeJS.ErrnoException | null));
      });

      assert.strictEqual(error?.code, 'ENOTFOUND');
      assert.strictEqual(error?.syscall, 'getaddrinfo');
      assert.strictEqual((error as { hostname?: string } | null)?.hostname, 'example.com');
    });

    it('answers a name from the namespace\'s resolver, without case or a trailing dot', async () => {
      const result = await inside(withResolver(), () => new Promise<{ address?: string; family?: number }>((resolvePromise, reject) => {
        lookup('DB.', (err, address, family) => err ? reject(err) : resolvePromise({ address, family }));
      }));

      assert.strictEqual(result.address, '172.18.0.3');
      assert.strictEqual(result.family, 4);
    });

    it('lookup({ all: true }) lists what the resolver holds in every family', async () => {
      const addresses = await inside(withResolver(), () => promises.lookup('postgres', { all: true }));
      expect(addresses).toEqual([{ address: '172.18.0.3', family: 4 }]);
    });

    it('is ENOTFOUND for a held name with no address of the asked family', async () => {
      await expect(inside(withResolver(), () => promises.lookup('db', { family: 6 }))).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it('resolves localhost to the namespace\'s own loopback whatever its resolver holds', async () => {
      await expect(inside(withResolver(), () => promises.lookup('localhost'))).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    });

    it('lookup({ all: true }) should return address objects', async () => {
      const addresses = await new Promise<Array<{ address: string; family: number }>>((resolvePromise) => {
        lookup('localhost', { all: true }, (err: any, allAddresses: any) => {
          expect(err).toBeNull();
          resolvePromise(allAddresses || []);
        });
      });

      expect(addresses.length).toBeGreaterThan(0);
      assert.strictEqual(addresses[0].address, '127.0.0.1');
      assert.strictEqual(addresses[0].family, 4);
    });
  });

  describe('resolve* callbacks', () => {
    it('resolve() asks the namespace\'s resolver for A records', async () => {
      const addresses = await inside(withResolver(), () => new Promise<string[]>((resolvePromise, reject) => {
        resolve('db', (err, result) => err ? reject(err) : resolvePromise(result || []));
      }));

      expect(addresses).toEqual(['172.18.0.3']);
    });

    it('resolve4() is ENOTFOUND for a name the resolver does not hold', async () => {
      const error = await new Promise<NodeJS.ErrnoException | null>((resolvePromise) => {
        resolve4('example.com', (err) => resolvePromise(err as NodeJS.ErrnoException | null));
      });

      assert.strictEqual(error?.code, 'ENOTFOUND');
      assert.strictEqual(error?.syscall, 'queryA');
    });

    it('resolve6() is ENODATA for a held name with no AAAA record', async () => {
      const error = await inside(withResolver(), () => new Promise<NodeJS.ErrnoException | null>((resolvePromise) => {
        resolve6('db', (err) => resolvePromise(err as NodeJS.ErrnoException | null));
      }));

      assert.strictEqual(error?.code, 'ENODATA');
      assert.strictEqual(error?.syscall, 'queryAaaa');
    });

    it('reverse() is ENOTFOUND: the resolver holds no PTR records', async () => {
      const error = await new Promise<NodeJS.ErrnoException | null>((resolvePromise) => {
        reverse('127.0.0.1', (err) => resolvePromise(err as NodeJS.ErrnoException | null));
      });

      assert.strictEqual(error?.code, 'ENOTFOUND');
    });
  });

  describe('servers and result order', () => {
    it('setServers() should be callable', () => {
      assert.doesNotThrow(() => setServers(['8.8.8.8']));
    });

    it('getServers() should return array', () => {
      const servers = getServers();
      expect(Array.isArray(servers)).toBe(true);
      expect(servers).toEqual([]);
    });

    it('setDefaultResultOrder() should be callable', () => {
      assert.doesNotThrow(() => setDefaultResultOrder('verbatim'));
      assert.doesNotThrow(() => setDefaultResultOrder('ipv4first'));
      assert.doesNotThrow(() => setDefaultResultOrder('ipv6first'));
    });

    it('getDefaultResultOrder() should return verbatim', () => {
      assert.strictEqual(getDefaultResultOrder(), 'verbatim');
    });
  });

  describe('promises API', () => {
    it('promises.lookup(host) should return address object', async () => {
      const result = await promises.lookup('localhost');
      expect(typeof result).toBe('object');
      const addr = result as { address: string; family: number };
      assert.strictEqual(addr.address, '127.0.0.1');
      assert.strictEqual(addr.family, 4);
    });

    it('promises.lookup(host, { all: true }) should return address list', async () => {
      const result = await promises.lookup('localhost', { all: true });
      expect(Array.isArray(result)).toBe(true);
      const addresses = result as Array<{ address: string; family: number }>;
      expect(addresses.length).toBeGreaterThan(0);
      assert.strictEqual(addresses[0].address, '127.0.0.1');
      assert.strictEqual(addresses[0].family, 4);
    });

    it('promises.resolve() answers the namespace\'s A records', async () => {
      await expect(inside(withResolver(), () => promises.resolve('db'))).resolves.toEqual(['172.18.0.3']);
    });

    it('promises.resolve(name, \'AAAA\') is ENODATA for a held name without one', async () => {
      await expect(inside(withResolver(), () => promises.resolve('db', 'AAAA'))).rejects.toMatchObject({ code: 'ENODATA' });
    });

    it('promises.resolve4() is ENOTFOUND for a name nothing holds', async () => {
      await expect(promises.resolve4('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND', syscall: 'queryA' });
    });

    it('promises.resolve6() is ENOTFOUND for a name nothing holds', async () => {
      await expect(promises.resolve6('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND', syscall: 'queryAaaa' });
    });

    it('promises.reverse() is ENOTFOUND', async () => {
      await expect(promises.reverse('127.0.0.1')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it('promises server helpers should be callable', () => {
      assert.doesNotThrow(() => promises.setServers(['1.1.1.1']));
      expect(promises.getServers()).toEqual([]);
    });
  });

  describe('default export', () => {
    it('should expose key APIs', () => {
      expect(dns.lookup).toBe(lookup);
      expect(dns.resolve).toBe(resolve);
      expect(dns.promises).toBe(promises);
      expect(dns.ADDRCONFIG).toBe(ADDRCONFIG);
    });
  });
});
