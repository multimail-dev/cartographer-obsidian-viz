import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// Match serve.ts's asset routes without reading a real vault. API responses
// are supplied by Playwright fixtures. The HTML lives in src, not public.
const assets = new Map([
  ["/", ["src/frontend/index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["src/frontend/index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["src/frontend/style.css", "text/css; charset=utf-8"]],
  ["/dist/app.js", ["public/dist/app.js", "text/javascript; charset=utf-8"]],
  ["/dist/fa3-worker.js", ["public/dist/fa3-worker.js", "text/javascript; charset=utf-8"]],
]);

createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1:4173").pathname;
  const asset = assets.get(pathname);
  if (!asset) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const [path, contentType] = asset;
    const content = await readFile(new URL(`../../apps/atlas-ui/${path}`, import.meta.url));
    response.writeHead(200, { "Content-Type": contentType }).end(content);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("Missing test asset; run bun run build first.");
  }
}).listen(4173, "127.0.0.1");
