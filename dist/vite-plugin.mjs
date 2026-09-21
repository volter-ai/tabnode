import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
const __dirname$1 = path.dirname(fileURLToPath(import.meta.url));
function tabnodePlugin(options = {}) {
  const swPath = options.swPath || "/__sw__.js";
  return {
    name: "tabnode",
    configureServer(server) {
      server.middlewares.use(swPath, (_req, res) => {
        let swFilePath = path.join(__dirname$1, "__sw__.js");
        if (!fs.existsSync(swFilePath)) {
          swFilePath = path.join(__dirname$1, "../dist/__sw__.js");
        }
        if (!fs.existsSync(swFilePath)) {
          res.statusCode = 404;
          res.end("Service worker file not found. Make sure tabnode is built.");
          return;
        }
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(fs.readFileSync(swFilePath));
      });
    }
  };
}
export {
  tabnodePlugin as default,
  tabnodePlugin
};
//# sourceMappingURL=vite-plugin.mjs.map
