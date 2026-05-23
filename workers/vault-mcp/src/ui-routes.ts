import type { Env } from "./env";
import { handleDiffRequest } from "./routes/ui/diff";
import { handleEnrichmentsRequest } from "./routes/ui/enrichments";
import { handleGraphEdgesRequest, handleGraphNodesRequest } from "./routes/ui/graph";
import { handleMetaRequest } from "./routes/ui/meta";
import { handleNoteRequest } from "./routes/ui/note";
import { handleSearchRequest } from "./routes/ui/search";
import { handleSnapshotsRequest } from "./routes/ui/snapshots";
import { handleViewsRequest } from "./routes/ui/views";

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleUiRequest(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/")) {
    return null;
  }

  if (url.pathname === "/api/graph/nodes") {
    return request.method === "GET" ? handleGraphNodesRequest(url, env) : methodNotAllowed();
  }

  if (url.pathname === "/api/graph/edges") {
    return request.method === "GET" ? handleGraphEdgesRequest(url, env) : methodNotAllowed();
  }

  if (url.pathname === "/api/meta") {
    return request.method === "GET" ? handleMetaRequest(env) : methodNotAllowed();
  }

  if (url.pathname === "/api/search") {
    return request.method === "GET" ? handleSearchRequest(url, env) : methodNotAllowed();
  }

  if (url.pathname === "/api/note") {
    return request.method === "GET" ? handleNoteRequest(url, env) : methodNotAllowed();
  }

  if (url.pathname === "/api/enrichments") {
    return request.method === "GET" ? handleEnrichmentsRequest(env) : methodNotAllowed();
  }

  if (url.pathname.startsWith("/api/views")) {
    const segments = url.pathname.slice("/api/views".length).split("/").filter(Boolean);
    return handleViewsRequest(request, env, segments);
  }

  if (url.pathname.startsWith("/api/snapshots")) {
    if (request.method !== "GET") return methodNotAllowed();
    const segments = url.pathname.slice("/api/snapshots".length).split("/").filter(Boolean);
    return handleSnapshotsRequest(request, env, segments);
  }

  if (url.pathname === "/api/diff") {
    return request.method === "GET" ? handleDiffRequest(url, env) : methodNotAllowed();
  }

  return null;
}
