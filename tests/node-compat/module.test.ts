/**
 * Node.js module module compatibility tests: the builtin list and isBuiltin.
 *
 * Adapted from: https://github.com/nodejs/node/blob/main/test/parallel/test-module-*.js
 */

import { describe, it, expect } from 'vitest';
import { builtinModules, isBuiltin } from '../../src/shims/module';
import { assert } from './common';

describe('module module (Node.js compat)', () => {
  describe('builtinModules and isBuiltin()', () => {
    it('should export builtinModules array', () => {
      expect(Array.isArray(builtinModules)).toBe(true);
      expect(builtinModules.length).toBeGreaterThan(0);
    });

    it('should include key core modules', () => {
      expect(builtinModules).toContain('fs');
      expect(builtinModules).toContain('path');
      expect(builtinModules).toContain('http');
      expect(builtinModules).toContain('worker_threads');
      expect(builtinModules).toContain('v8');
    });

    it('isBuiltin() should return true for listed builtins', () => {
      assert.strictEqual(isBuiltin('fs'), true);
      assert.strictEqual(isBuiltin('path'), true);
      assert.strictEqual(isBuiltin('worker_threads'), true);
    });

    it('isBuiltin() should support node: prefix', () => {
      assert.strictEqual(isBuiltin('node:fs'), true);
      assert.strictEqual(isBuiltin('node:path'), true);
    });

    it('isBuiltin() should return false for non-builtins', () => {
      assert.strictEqual(isBuiltin('left-pad'), false);
      assert.strictEqual(isBuiltin('./local-module'), false);
    });
  });
});
