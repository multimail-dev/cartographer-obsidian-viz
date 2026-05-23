import indexHtml from "../public/index.html";
import styleCss from "../public/style.css";
import appJs from "../public/dist/app.js.txt";
import fa3WorkerJs from "../public/dist/fa3-worker.js.txt";

function contentHash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

const cssHash = contentHash(styleCss);
const jsHash = contentHash(appJs);
const workerHash = contentHash(fa3WorkerJs);

const cachedHtml = indexHtml
  .replace("/style.css", `/style.css?v=${cssHash}`)
  .replace("/dist/app.js", `/dist/app.js?v=${jsHash}`)
  .replace("/dist/fa3-worker.js", `/dist/fa3-worker.js?v=${workerHash}`);

function versionedCacheControl(url: URL): string {
  return url.searchParams.has("v")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=60, must-revalidate";
}

export function handleUiAssetRequest(url: URL): Response | null {
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(cachedHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  if (url.pathname === "/style.css") {
    return new Response(styleCss, {
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": versionedCacheControl(url),
      },
    });
  }

  if (url.pathname === "/dist/app.js") {
    return new Response(appJs, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": versionedCacheControl(url),
      },
    });
  }

  if (url.pathname === "/dist/fa3-worker.js") {
    return new Response(fa3WorkerJs, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": versionedCacheControl(url),
      },
    });
  }

  if (url.pathname === "/dist/app.js.map" || url.pathname === "/dist/fa3-worker.js.map") {
    return new Response(null, { status: 204 });
  }

  return null;
}

