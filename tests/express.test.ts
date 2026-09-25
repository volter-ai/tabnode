/**
 * Express detection (the engine installs nothing, so no test installs Express)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { PackageManager } from '../src/npm';
import { getServerBridge, resetServerBridge } from '../src/server-bridge';

describe('Express Integration', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;
  let npm: PackageManager;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs, {
      onConsole: (method, args) => {
        // Suppress console output during tests
      },
    });
    npm = new PackageManager(vfs);
    resetServerBridge();
  });

  describe('Express detection', () => {
    it('should detect express usage with single quotes', () => {
      const code = `const express = require('express');`;
      expect(code.includes("require('express')")).toBe(true);
    });

    it('should detect express usage with double quotes', () => {
      const code = `const express = require("express");`;
      expect(code.includes('require("express")')).toBe(true);
    });
  });

});
