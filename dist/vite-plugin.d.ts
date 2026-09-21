/**
 * Vite Plugin for tabnode
 *
 * Serves the service worker file from the package's dist directory,
 * enabling seamless integration when tabnode is installed as an npm package.
 */
import type { Plugin } from 'vite';
export interface TabnodePluginOptions {
    /**
     * The URL path where the service worker will be served
     * @default '/__sw__.js'
     */
    swPath?: string;
}
/**
 * Vite plugin that serves the tabnode service worker file.
 *
 * When tabnode is installed as an npm package, the service worker file
 * is located at node_modules/tabnode/dist/__sw__.js but the browser
 * tries to load it from the root URL (/__sw__.js). This plugin intercepts
 * requests to the service worker path and serves the file from the correct location.
 *
 * @example
 * ```typescript
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { tabnodePlugin } from 'tabnode/vite';
 *
 * export default defineConfig({
 *   plugins: [tabnodePlugin()]
 * });
 * ```
 */
export declare function tabnodePlugin(options?: TabnodePluginOptions): Plugin;
export default tabnodePlugin;
//# sourceMappingURL=vite-plugin.d.ts.map