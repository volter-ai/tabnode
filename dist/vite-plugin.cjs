"use strict";
Object.defineProperties(exports, { __esModule: { value: true }, [Symbol.toStringTag]: { value: "Module" } });
const fs = require("fs");
const path = require("path");
const url = require("url");
var _documentCurrentScript = typeof document !== "undefined" ? document.currentScript : null;
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const __dirname$1 = path__namespace.dirname(url.fileURLToPath(typeof document === "undefined" ? require("url").pathToFileURL(__filename).href : _documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === "SCRIPT" && _documentCurrentScript.src || new URL("vite-plugin.cjs", document.baseURI).href));
function tabnodePlugin(options = {}) {
  const swPath = options.swPath || "/__sw__.js";
  return {
    name: "tabnode",
    configureServer(server) {
      server.middlewares.use(swPath, (_req, res) => {
        let swFilePath = path__namespace.join(__dirname$1, "__sw__.js");
        if (!fs__namespace.existsSync(swFilePath)) {
          swFilePath = path__namespace.join(__dirname$1, "../dist/__sw__.js");
        }
        if (!fs__namespace.existsSync(swFilePath)) {
          res.statusCode = 404;
          res.end("Service worker file not found. Make sure tabnode is built.");
          return;
        }
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(fs__namespace.readFileSync(swFilePath));
      });
    }
  };
}
exports.default = tabnodePlugin;
exports.tabnodePlugin = tabnodePlugin;
//# sourceMappingURL=vite-plugin.cjs.map
