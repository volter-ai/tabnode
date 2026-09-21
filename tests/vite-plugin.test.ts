import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tabnodePlugin } from '../src/vite-plugin';
import type { ViteDevServer, Connect } from 'vite';

describe('tabnodePlugin', () => {
  describe('plugin configuration', () => {
    it('should return a plugin with correct name', () => {
      const plugin = tabnodePlugin();
      expect(plugin.name).toBe('tabnode');
    });

    it('should have configureServer hook', () => {
      const plugin = tabnodePlugin();
      expect(plugin.configureServer).toBeDefined();
      expect(typeof plugin.configureServer).toBe('function');
    });
  });

  describe('configureServer middleware', () => {
    let mockUse: ReturnType<typeof vi.fn>;
    let mockServer: ViteDevServer;

    beforeEach(() => {
      mockUse = vi.fn();
      mockServer = {
        middlewares: {
          use: mockUse,
        },
      } as unknown as ViteDevServer;
    });

    it('should register middleware for default path /__sw__.js', () => {
      const plugin = tabnodePlugin();
      (plugin.configureServer as (server: ViteDevServer) => void)(mockServer);

      expect(mockUse).toHaveBeenCalledTimes(1);
      expect(mockUse.mock.calls[0][0]).toBe('/__sw__.js');
      expect(typeof mockUse.mock.calls[0][1]).toBe('function');
    });

    it('should register middleware for custom path', () => {
      const plugin = tabnodePlugin({ swPath: '/custom/__sw__.js' });
      (plugin.configureServer as (server: ViteDevServer) => void)(mockServer);

      expect(mockUse).toHaveBeenCalledTimes(1);
      expect(mockUse.mock.calls[0][0]).toBe('/custom/__sw__.js');
    });

    it('should serve service worker file with correct headers', async () => {
      const plugin = tabnodePlugin();
      (plugin.configureServer as (server: ViteDevServer) => void)(mockServer);

      const middleware = mockUse.mock.calls[0][1] as Connect.NextHandleFunction;

      const mockRes = {
        setHeader: vi.fn(),
        statusCode: 200,
        end: vi.fn(),
      };

      // Call the middleware
      middleware({} as Connect.IncomingMessage, mockRes as unknown as any, vi.fn());

      // Should attempt to set correct headers
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/javascript');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    });
  });

  describe('options', () => {
    it('should use default swPath when not specified', () => {
      const plugin = tabnodePlugin();
      const mockUse = vi.fn();
      const mockServer = { middlewares: { use: mockUse } } as unknown as ViteDevServer;

      (plugin.configureServer as (server: ViteDevServer) => void)(mockServer);

      expect(mockUse.mock.calls[0][0]).toBe('/__sw__.js');
    });

    it('should accept empty options object', () => {
      const plugin = tabnodePlugin({});
      const mockUse = vi.fn();
      const mockServer = { middlewares: { use: mockUse } } as unknown as ViteDevServer;

      (plugin.configureServer as (server: ViteDevServer) => void)(mockServer);

      expect(mockUse.mock.calls[0][0]).toBe('/__sw__.js');
    });
  });
});
