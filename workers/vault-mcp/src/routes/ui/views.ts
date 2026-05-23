import { z } from "zod";
import type { Env } from "../../env";

const MAX_STATE_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2048;
const slugRegex = /^[a-z0-9][a-z0-9-]{0,63}$/;

const viewSchema = z.object({
  slug: z.string().regex(slugRegex, "slug must be lowercase alphanumeric + dashes, max 64 chars"),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).default(""),
  state: z.record(z.string(), z.unknown()),
});

const viewUpdateSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
});

interface ViewRow {
  id: number;
  user_id: string;
  slug: string;
  public_id: string;
  title: string;
  description: string;
  state: string;
  created_at: number;
  updated_at: number;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function serialiseView(row: ViewRow) {
  let state: unknown;
  try {
    state = JSON.parse(row.state);
  } catch {
    state = {};
  }

  return {
    slug: row.slug,
    public_id: row.public_id,
    title: row.title,
    description: row.description,
    state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getUserId(request: Request): string {
  return request.headers.get("cf-access-authenticated-user-email") ?? "anonymous";
}

function stateTooLarge(stateJson: string): boolean {
  return new TextEncoder().encode(stateJson).byteLength > MAX_STATE_BYTES;
}

export async function handleViewsRequest(request: Request, env: Env, segments: string[]): Promise<Response> {
  const userId = getUserId(request);

  if (request.method === "GET" && segments.length === 0) {
    const res = await env.DB.prepare(
      `SELECT id, user_id, slug, public_id, title, description, state, created_at, updated_at
       FROM saved_views
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT 100`
    ).bind(userId).all<ViewRow>();

    return json({
      user_id: userId,
      views: (res.results ?? []).map(serialiseView),
    });
  }

  if (request.method === "POST" && segments.length === 0) {
    let parsed: z.infer<typeof viewSchema>;
    try {
      parsed = viewSchema.parse(await request.json());
    } catch (error) {
      return json({ error: "invalid payload", detail: String(error) }, { status: 400 });
    }

    const stateJson = JSON.stringify(parsed.state);
    if (stateTooLarge(stateJson)) {
      return json({ error: "state too large", max_bytes: MAX_STATE_BYTES }, { status: 413 });
    }

    const publicId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const now = Date.now();

    try {
      await env.DB.prepare(
        `INSERT INTO saved_views (user_id, slug, public_id, title, description, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(userId, parsed.slug, publicId, parsed.title, parsed.description, stateJson, now, now).run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return json({ error: "slug already exists for this user", slug: parsed.slug }, { status: 409 });
      }
      throw error;
    }

    return json({
      slug: parsed.slug,
      public_id: publicId,
      title: parsed.title,
      description: parsed.description,
      state: parsed.state,
      created_at: now,
      updated_at: now,
    }, { status: 201 });
  }

  if (request.method === "GET" && segments[0] === "public") {
    const publicId = segments[1];
    if (!publicId) return json({ error: "publicId required" }, { status: 400 });

    const row = await env.DB.prepare(
      `SELECT id, user_id, slug, public_id, title, description, state, created_at, updated_at
       FROM saved_views
       WHERE public_id = ?`
    ).bind(publicId).first<ViewRow>();

    if (!row) {
      return json({ error: "not found", public_id: publicId }, { status: 404 });
    }

    const view = serialiseView(row);
    return json({
      public_id: view.public_id,
      title: view.title,
      description: view.description,
      state: view.state,
      created_at: view.created_at,
      updated_at: view.updated_at,
    });
  }

  const slug = segments[0];
  if (!slug) {
    return json({ error: "not found" }, { status: 404 });
  }

  if (request.method === "GET") {
    if (slug === "public") return json({ error: "use /api/views/public/:publicId" }, { status: 400 });

    const row = await env.DB.prepare(
      `SELECT id, user_id, slug, public_id, title, description, state, created_at, updated_at
       FROM saved_views
       WHERE user_id = ? AND slug = ?`
    ).bind(userId, slug).first<ViewRow>();

    if (!row) return json({ error: "not found", slug }, { status: 404 });
    return json(serialiseView(row));
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    let parsed: z.infer<typeof viewUpdateSchema>;
    try {
      parsed = viewUpdateSchema.parse(await request.json());
    } catch (error) {
      return json({ error: "invalid payload", detail: String(error) }, { status: 400 });
    }

    const existing = await env.DB.prepare(
      `SELECT id, user_id, slug, public_id, title, description, state, created_at, updated_at
       FROM saved_views
       WHERE user_id = ? AND slug = ?`
    ).bind(userId, slug).first<ViewRow>();

    if (!existing) return json({ error: "not found", slug }, { status: 404 });

    const newTitle = parsed.title ?? existing.title;
    const newDescription = parsed.description ?? existing.description;
    const newStateJson = parsed.state ? JSON.stringify(parsed.state) : existing.state;

    if (stateTooLarge(newStateJson)) {
      return json({ error: "state too large", max_bytes: MAX_STATE_BYTES }, { status: 413 });
    }

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE saved_views
       SET title = ?, description = ?, state = ?, updated_at = ?
       WHERE user_id = ? AND slug = ?`
    ).bind(newTitle, newDescription, newStateJson, now, userId, slug).run();

    const updated = await env.DB.prepare(
      `SELECT id, user_id, slug, public_id, title, description, state, created_at, updated_at
       FROM saved_views
       WHERE user_id = ? AND slug = ?`
    ).bind(userId, slug).first<ViewRow>();

    return json(serialiseView(updated!));
  }

  if (request.method === "DELETE") {
    const res = await env.DB.prepare(
      "DELETE FROM saved_views WHERE user_id = ? AND slug = ?"
    ).bind(userId, slug).run();

    if ((res.meta?.changes ?? 0) === 0) {
      return json({ error: "not found", slug }, { status: 404 });
    }

    return json({ ok: true, slug });
  }

  return json({ error: "method not allowed" }, { status: 405 });
}

