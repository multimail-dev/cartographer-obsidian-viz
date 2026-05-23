/**
 * Hono sub-app for vault-mcp — plan005 F2/F3.
 *
 * Mounts:
 *   GET /api/frontmatter/schema
 *   GET /api/frontmatter/filter
 *   GET /api/vault/drift
 *   GET /api/vault/propagate
 *
 * All routes are protected by the verifyBearer middleware (SHA-256
 * constant-time comparison against SHARED_SECRET). 0-byte, oversized, and
 * multi-byte UTF tokens all return 401 clean — no throws.
 *
 * /api/diff is intentionally NOT registered here — the pre-plan005
 * handleDiffRequest in src/routes/ui/diff.ts is the canonical handler
 * (richer field-change detection + unauth on UI host). Wave 2-B's ported
 * hono/diff.ts would have shadowed it behind a bearer gate and reduced
 * functionality. (Self-review round-24 finding.)
 *
 * Call withFallthrough(handler) once at Worker startup (in index.ts) to
 * register the catch-all that delegates unmatched routes to the legacy
 * bespoke dispatcher. Tests that want to exercise the fallthrough path
 * call withFallthrough with a stub handler.
 *
 * DOES NOT import from hono/jsx or hono/validator.
 */
import { Hono } from "hono";
import { verifyBearer } from "../auth/bearer";
import type { Env } from "../env";
import { frontmatterRoutes } from "./hono/frontmatter";
import { cognitiveRoutes } from "./hono/cognitive";

export const honoApp = new Hono<{ Bindings: Env }>();

// Auth middleware — scoped to the ported Hono routes ONLY, not the Hono
// catch-all. If we used "*" here, withFallthrough(legacyDispatch) would sit
// behind this middleware too, and every UI/OAuth/static request to the worker
// would return 401 because the default fetch export now points at honoApp.
// (Codex P0 finding against plan005/integration.)
const bearerGuard = async (
  c: { req: { raw: Request }; env: Env; text: (b: string, s: number) => Response },
  next: () => Promise<void>,
) => {
  if (!(await verifyBearer(c.req.raw, c.env.SHARED_SECRET))) {
    return c.text("Unauthorized", 401);
  }
  await next();
};
honoApp.use("/api/frontmatter/*", bearerGuard);
honoApp.use("/api/vault/*", bearerGuard);

honoApp.route("/", frontmatterRoutes);
honoApp.route("/", cognitiveRoutes);

/**
 * F3 — Register a catch-all fallthrough handler on the Hono app.
 * Must be called exactly once, after all specific routes are mounted.
 * In production, called by index.ts with legacyDispatch.
 * In tests, called with a stub to exercise the fallthrough code path.
 */
export function withFallthrough(
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>
): void {
  honoApp.all("*", (c) => {
    // c.executionCtx throws when there is no execution context (e.g. unit tests).
    // Provide a no-op stub in that case — the fallthrough handler must not crash.
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    }
    return handler(c.req.raw, c.env, ctx);
  });
}
