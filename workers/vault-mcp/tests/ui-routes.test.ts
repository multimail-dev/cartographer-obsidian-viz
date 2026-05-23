// Integration tests for the ported UI handlers at src/routes/ui/*.ts and
// src/snapshots.ts. The primary goal is to catch the SQLite LIKE-underscore
// wildcard bug class: `path NOT LIKE '__%'` matches every string ≥2 chars, -- LIKE-OK: doc comment describing the bug class
// so the filter intended to exclude sentinel rows (__last_build_completed__,
// __last_sync__, etc.) silently drops all real notes. The fix landed in
// PR #6 (commit 6cd97ad) by switching every
// ported site from `LIKE '__%'` to `GLOB '__*'`. These tests lock that fix -- LIKE-OK: doc comment describing the fix
// in place — a regression to LIKE will fail them.
//
// The tests use bun:sqlite as an in-memory SQLite engine, wrapped in a
// minimal D1Database-shaped adapter so the ported handlers can run
// unchanged. This avoids spinning up wrangler dev and the associated KV
// preview_id dance.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";

import { handleMetaRequest } from "../src/routes/ui/meta";
import {
	handleGraphNodesRequest,
	handleGraphEdgesRequest,
} from "../src/routes/ui/graph";
import { handleSearchRequest } from "../src/routes/ui/search";
import { handleEnrichmentsRequest } from "../src/routes/ui/enrichments";
import { handleNoteRequest, resetNoteCounts, d1HitCount, d1MissCount } from "../src/routes/ui/note";
import { handleViewsRequest } from "../src/routes/ui/views";
import { handleSnapshotsRequest } from "../src/routes/ui/snapshots";
import { writeVaultSnapshot } from "../src/snapshots";

// ----- minimal D1Database adapter over bun:sqlite ---------------------------
//
// Shape-matches the subset of the D1Database API the ported handlers actually
// use: `prepare(sql).bind(...args).first<T>() | .all<T>() | .run()`. Result
// shapes match the real D1 runtime:
//   first<T>()  → T | null
//   all<T>()    → { results: T[], success: boolean, meta: { changes, duration, last_row_id, rows_read, rows_written } }
//   run()       → { success: boolean, meta: { ... }, results: T[] }
// Codex review of PR #9 flagged that the earlier adapter was missing `success`
// and the full `meta` shape, which would let a shape-dependent regression
// slip through. Fleshed out to reduce that drift risk.

function d1(db: BunDatabase): any {
	return {
		prepare(sql: string) {
			let boundArgs: any[] = [];
			const stmt = {
				bind(...args: any[]) {
					boundArgs = args;
					return stmt;
				},
				async first<T>(): Promise<T | null> {
					const row = db.query(sql).get(...boundArgs);
					return (row as T) ?? null;
				},
				async all<T>(): Promise<{
					results: T[];
					success: boolean;
					meta: { changes: number; duration: number; last_row_id: number; rows_read: number; rows_written: number };
				}> {
					const rows = db.query(sql).all(...boundArgs) as T[];
					return {
						results: rows ?? [],
						success: true,
						meta: { changes: 0, duration: 0, last_row_id: 0, rows_read: rows?.length ?? 0, rows_written: 0 },
					};
				},
				async run(): Promise<{
					success: boolean;
					results: never[];
					meta: { changes: number; duration: number; last_row_id: number; rows_read: number; rows_written: number };
				}> {
					const result = db.query(sql).run(...boundArgs);
					return {
						success: true,
						results: [],
						meta: {
							changes: result.changes ?? 0,
							duration: 0,
							last_row_id: Number(result.lastInsertRowid ?? 0),
							rows_read: 0,
							rows_written: result.changes ?? 0,
						},
					};
				},
			};
			return stmt;
		},
	};
}

// Minimal in-memory R2 bucket for snapshots.
function r2(): any {
	const store = new Map<string, { body: string; customMetadata: any }>();
	return {
		async put(key: string, body: string, opts: any) {
			store.set(key, { body, customMetadata: opts?.customMetadata ?? {} });
		},
		async get(key: string) {
			const entry = store.get(key);
			if (!entry) return null;
			return { async text() { return entry.body; } };
		},
		// Exposed for tests.
		_store: store,
	};
}

// ----- schema (copied verbatim from live remote vault-graph D1) -------------

const SCHEMA_SQL = `
CREATE TABLE vault_nodes (
  path TEXT PRIMARY KEY,
  title TEXT,
  note_type TEXT,
  folder TEXT,
  tags TEXT,
  in_degree INTEGER DEFAULT 0,
  out_degree INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0,
  modified_at TEXT,
  indexed_at TEXT DEFAULT (datetime('now')),
  aliases TEXT DEFAULT '[]',
  body TEXT
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE vault_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source, target, edge_type)
);

CREATE TABLE vault_enrichment (
  path TEXT PRIMARY KEY,
  pagerank REAL DEFAULT 0.0,
  prev_pagerank REAL DEFAULT 0.0,
  computed_at INTEGER DEFAULT 0,
  cluster_id INTEGER,
  component_id INTEGER,
  clustering_coeff REAL
);

-- FTS5 virtual table. bun:sqlite bundles fts5 by default.
CREATE VIRTUAL TABLE vault_fts USING fts5(
  path UNINDEXED,
  title,
  tags,
  folder,
  tokenize='porter'
);

CREATE TABLE saved_views (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  public_id    TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(user_id, slug)
);

CREATE TABLE snapshot_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  node_count  INTEGER NOT NULL,
  edge_count  INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('pending','persisted','failed'))
);

CREATE TABLE enrich_cursor (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  phase           TEXT    NOT NULL DEFAULT 'algorithm',
  lease_expires   INTEGER NOT NULL DEFAULT 0,
  lease_owner     TEXT,
  last_node_id    TEXT,
  last_run_at     INTEGER NOT NULL DEFAULT 0,
  nodes_processed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO enrich_cursor (id, phase) VALUES (1, 'algorithm');
`;

// ----- fixture data ---------------------------------------------------------

// 3 sentinel rows with underscore-prefixed paths. These are EXACTLY the kind
// of rows the ported handlers' sentinel filter is supposed to exclude.
const SENTINELS: Array<[string, string]> = [
	["__last_build_completed__", "build_graph"],
	["__last_sync__", "sync_graph"],
	["__structural_neighbors__", "precompute"],
];

// 5 real note rows spread across 3 folders. Chosen so topFolders ordering is
// deterministic: Concepts has 2, Projects has 2, People has 1.
const REAL_NODES: Array<[string, string, string, string]> = [
	// [path, title, folder, tags JSON]
	["Concepts/ExampleProject", "Example Project", "Concepts", '["concept","example_project"]'],
	["Concepts/VaultGraph", "Vault Graph", "Concepts", '["concept","graph"]'],
	["Projects/Phase3", "Phase 3", "Projects", '["project","phase3"]'],
	["Projects/Phase4", "Phase 4", "Projects", '["project","phase4"]'],
	["People/Alice", "Alice", "People", '["person"]'],
];

function seed(db: BunDatabase) {
	db.run(SCHEMA_SQL);

	for (const [path, title] of SENTINELS) {
		db.query(
			"INSERT INTO vault_nodes (path, title, note_type, folder, tags, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(path, title, null, "", "[]", "2026-04-12T00:00:00.000Z");
	}

	for (const [path, title, folder, tags] of REAL_NODES) {
		db.query(
			"INSERT INTO vault_nodes (path, title, note_type, folder, tags, modified_at, size) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(path, title, "note", folder, tags, "2026-04-12T10:00:00.000Z", 1000);
		db.query(
			"INSERT INTO vault_fts (path, title, tags, folder) VALUES (?, ?, ?, ?)",
		).run(path, title, tags, folder);
	}

	// Edges between the real nodes. 7 edges across 3 types (wikilink, tag, related).
	const edges: Array<[string, string, string]> = [
		["Concepts/ExampleProject", "Concepts/VaultGraph", "wikilink"],
		["Concepts/ExampleProject", "Projects/Phase3", "wikilink"],
		["Concepts/VaultGraph", "Projects/Phase3", "wikilink"],
		["Projects/Phase3", "Projects/Phase4", "wikilink"],
		["People/Alice", "Projects/Phase3", "related"],
		["People/Alice", "Projects/Phase4", "related"],
		["Concepts/ExampleProject", "concept", "tag"],
	];
	for (const [source, target, type] of edges) {
		db.query(
			"INSERT INTO vault_edges (source, target, edge_type) VALUES (?, ?, ?)",
		).run(source, target, type);
	}

	// Enrichment rows for 2 of the real nodes.
	db.query(
		"INSERT INTO vault_enrichment (path, pagerank, cluster_id, component_id, clustering_coeff, computed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
	).run("Concepts/ExampleProject", 0.42, 1, 0, 0.75);
	db.query(
		"INSERT INTO vault_enrichment (path, pagerank, cluster_id, component_id, clustering_coeff, computed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
	).run("Projects/Phase3", 0.31, 2, 0, 0.50);
}

// ----- tests ----------------------------------------------------------------

describe("ported UI handlers — sentinel-row filter", () => {
	let db: BunDatabase;
	let env: any;

	beforeEach(() => {
		db = new BunDatabase(":memory:");
		seed(db);
		env = {
			DB: d1(db),
			VAULT_SNAPSHOTS: r2(),
		};
	});

	test("/api/meta returns nodeCount excluding 3 sentinel rows", async () => {
		const res = await handleMetaRequest(env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		// 5 real rows + 3 sentinels = 8 total; sentinels excluded → 5.
		expect(body.nodeCount).toBe(5);
		// All 7 edges count — no filter on vault_edges.
		expect(body.edgeCount).toBe(7);
		// edgeTypes sorted by count desc, then name asc. wikilink=4, related=2, tag=1.
		expect(body.edgeTypes).toEqual(["wikilink", "related", "tag"]);
	});

	test("/api/meta topFolders excludes sentinel rows' empty folder", async () => {
		const res = await handleMetaRequest(env);
		const body = (await res.json()) as any;
		// Sentinels have folder='' and would appear as the top folder if not
		// filtered. Real folders: Concepts=2, Projects=2, People=1.
		const folderNames = body.topFolders.map((f: any) => f.folder);
		expect(folderNames).not.toContain("");
		expect(folderNames).toContain("Concepts");
		expect(folderNames).toContain("Projects");
		expect(folderNames).toContain("People");
		// Confirm counts.
		const conceptsRow = body.topFolders.find((f: any) => f.folder === "Concepts");
		expect(conceptsRow.count).toBe(2);
	});

	test("/api/graph/nodes total and items exclude sentinels", async () => {
		const url = new URL("http://test/api/graph/nodes?limit=100");
		const res = await handleGraphNodesRequest(url, env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		expect(body.total).toBe(5);
		expect(body.items).toHaveLength(5);
		const ids = body.items.map((i: any) => i.id);
		expect(ids).not.toContain("__last_build_completed__");
		expect(ids).not.toContain("__last_sync__");
		expect(ids).not.toContain("__structural_neighbors__");
		// pagerank is populated for the 2 nodes that have centrality rows.
		const dav = body.items.find((i: any) => i.id === "Concepts/ExampleProject");
		expect(dav.pagerank).toBe(0.42);
	});

	test("/api/graph/edges total matches raw edge count (no filter)", async () => {
		const url = new URL("http://test/api/graph/edges?limit=100");
		const res = await handleGraphEdgesRequest(url, env);
		const body = (await res.json()) as any;
		expect(body.total).toBe(7);
		expect(body.items).toHaveLength(7);
	});

	test("/api/search (FTS5) returns results excluding sentinels", async () => {
		const url = new URL("http://test/api/search?q=example-project");
		const res = await handleSearchRequest(url, env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		// Concepts/ExampleProject should match on title + tag.
		expect(body.results).toContain("Concepts/ExampleProject");
		// None of the sentinel paths should ever appear.
		for (const r of body.results) {
			expect(r.startsWith("__")).toBe(false);
		}
	});

	test("/api/search (LIKE-scan fallback) excludes sentinels when FTS5 is unavailable", async () => {
		// Codex PR #9 review flagged that only the FTS5 path was covered, not
		// the LIKE-scan fallback at search.ts:47-75 which ALSO carries the
		// sentinel filter. Drop vault_fts so the handler catches the "no such
		// table" error inside searchViaFts5, returns null, and falls through
		// to searchViaLikeScan.
		db.run("DROP TABLE vault_fts");

		// Also insert a sentinel row whose title contains the search term —
		// if the filter regressed from GLOB to LIKE, this row would come back
		// because `LIKE '__%'` matches every ≥2-char path. -- LIKE-OK: comment
		db.query(
			"INSERT INTO vault_nodes (path, title, note_type, folder, tags) VALUES (?, ?, ?, ?, ?)",
		).run("__example_project_sentinel__", "Example Project sentinel", null, "", "[]");

		const url = new URL("http://test/api/search?q=Example%20Project");
		const res = await handleSearchRequest(url, env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		// The real note is found via LIKE-scan on title.
		expect(body.results).toContain("Concepts/ExampleProject");
		// The sentinel whose title/path contains the search term MUST NOT appear.
		expect(body.results).not.toContain("__example_project_sentinel__");
		for (const r of body.results) {
			expect(r.startsWith("__")).toBe(false);
		}
	});

	test("/api/enrichments returns zeros when no meta rows seeded", async () => {
		// No meta rows in DB yet — handler must return zeros, not nulls.
		const res = await handleEnrichmentsRequest(env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		expect(body.version).toBe(0);
		expect(body.lastRunAt).toBe(0);
		// communityCount is derived from vault_enrichment DISTINCT cluster_id count.
		// Fixture seeds 2 rows with cluster_id 1 and 2 → communityCount=2.
		expect(body.communityCount).toBe(2);
		expect(typeof body.phase).toBe("string");
	});

	test("/api/enrichments returns real values after seeding meta rows", async () => {
		db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("enrichment_version", "3");
		db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("last_enrichment_at", "1744500000");
		db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("enrichment_community_count", "7");
		// Phase lives in enrich_cursor, not meta (round-2 codex fix).
		db.query("UPDATE enrich_cursor SET phase = 'backfill' WHERE id = 1").run();

		const res = await handleEnrichmentsRequest(env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		expect(body.version).toBe(3);
		expect(body.lastRunAt).toBe(1744500000);
		expect(body.communityCount).toBe(7);
		expect(body.phase).toBe("backfill");
	});

	test("/api/meta includes enrichment fields from meta table", async () => {
		db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("enrichment_version", "5");
		db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("last_enrichment_at", "1744600000");
		db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("enrichment_community_count", "12");

		const res = await handleMetaRequest(env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		expect(body.enrichmentVersion).toBe(5);
		expect(body.lastEnrichmentAt).toBe(1744600000);
		expect(body.enrichmentCommunityCount).toBe(12);
		// lastIngestRunId is always null until an ingest agent sets it.
		expect(body.lastIngestRunId).toBeNull();
	});

	test("/api/graph/nodes?include=enrichment includes pagerank/cluster_id for seeded nodes", async () => {
		const url = new URL("http://test/api/graph/nodes?include=enrichment&limit=100");
		const res = await handleGraphNodesRequest(url, env);
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);

		// Concepts/ExampleProject has enrichment: pagerank=0.42, cluster_id=1, component_id=0, clustering_coeff=0.75
		const dav = body.items.find((i: any) => i.id === "Concepts/ExampleProject");
		expect(dav).toBeDefined();
		expect(dav.pagerank).toBe(0.42);
		expect(dav.clusterId).toBe(1);
		expect(dav.componentId).toBe(0);
		expect(dav.clusteringCoeff).toBe(0.75);

		// People/Alice has no enrichment row → enrichment fields should be null.
		const alice = body.items.find((i: any) => i.id === "People/Alice");
		expect(alice).toBeDefined();
		expect(alice.pagerank).toBeNull();
		expect(alice.clusterId).toBeNull();
	});

	test("/api/graph/nodes without ?include=enrichment returns full enrichment fields from join", async () => {
		// The bundled UI (public/dist/app.js) calls /api/graph/nodes without
		// the include= param but reads clusterId/componentId/clusteringCoeff
		// directly from each item for community coloring and the detail panel.
		// Gating those behind include=enrichment silently broke community mode.
		// (Codex round-45 P1 finding.)
		const url = new URL("http://test/api/graph/nodes?limit=100");
		const res = await handleGraphNodesRequest(url, env);
		const body = (await res.json()) as any;
		const dav = body.items.find((i: any) => i.id === "Concepts/ExampleProject");
		expect(dav.pagerank).toBe(0.42);
		expect(dav.clusterId).toBe(1);
		expect(dav.componentId).toBe(0);
		expect(dav.clusteringCoeff).toBe(0.75);
	});

	test("/api/note R2-first: serves fresh body from R2 (source of truth)", async () => {
		// Even when D1 body is populated with stale content, R2 wins.
		db.query("UPDATE vault_nodes SET body = ? WHERE path = ?").run("# STALE D1 COPY", "Concepts/ExampleProject");
		const vaultR2 = r2();
		await vaultR2.put("Concepts/ExampleProject.md", "# Example Project fresh R2", {});
		env.VAULT = vaultR2;

		resetNoteCounts();
		const url = new URL("http://test/api/note?path=Concepts/ExampleProject");
		const res = await handleNoteRequest(url, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/plain");
		const text = await res.text();
		expect(text).toBe("# Example Project fresh R2");
		// R2 hit — no D1 miss counter increment.
		expect(d1HitCount).toBe(0);
		expect(d1MissCount).toBe(0);
	});

	test("/api/note returns 404 on R2 miss even when D1 body exists (codex round-16)", async () => {
		// R2 definitive miss = note deleted or never existed. The stale D1
		// body must NOT be served — that would recreate the deleted-note
		// correctness regression. Only R2 errors fall through to D1.
		db.query("UPDATE vault_nodes SET body = ? WHERE path = ?").run("# Stale copy", "Concepts/ExampleProject");
		env.VAULT = r2(); // empty R2 → definitive miss (not error)

		resetNoteCounts();
		const url = new URL("http://test/api/note?path=Concepts/ExampleProject");
		const res = await handleNoteRequest(url, env);
		expect(res.status).toBe(404);
		// D1 was never consulted on definitive R2 miss.
		expect(d1MissCount).toBe(0);
		expect(d1HitCount).toBe(0);
	});

	test("/api/note falls back to D1 body when R2 throws (degraded mode)", async () => {
		// R2 error (not miss) = degraded mode. D1 is consulted as last resort.
		db.query("UPDATE vault_nodes SET body = ? WHERE path = ?").run("# Fallback body", "Concepts/ExampleProject");
		env.VAULT = {
			get: async () => { throw new Error("r2 unreachable"); },
		} as any;

		resetNoteCounts();
		const url = new URL("http://test/api/note?path=Concepts/ExampleProject");
		const res = await handleNoteRequest(url, env);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe("# Fallback body");
		expect(res.headers.get("X-Cartographer-Source")).toBe("d1-fallback");
		expect(d1MissCount).toBe(1);
		expect(d1HitCount).toBe(1);
	});

	test("/api/note returns 503 when R2 errors AND D1 cache is empty", async () => {
		env.VAULT = {
			get: async () => { throw new Error("r2 unreachable"); },
		} as any;
		resetNoteCounts();
		const url = new URL("http://test/api/note?path=Does/NotExist");
		const res = await handleNoteRequest(url, env);
		expect(res.status).toBe(503);
		expect(d1MissCount).toBe(1);
	});

	test("/api/note returns 400 when path param is missing", async () => {
		resetNoteCounts();
		const url = new URL("http://test/api/note");
		const res = await handleNoteRequest(url, env);
		expect(res.status).toBe(400);
	});

	test("/api/views CRUD round-trip works against saved_views table", async () => {
		const mkReq = (method: string, body?: any) =>
			new Request("http://test/api/views", {
				method,
				headers: {
					"content-type": "application/json",
					"cf-access-authenticated-user-email": "test@example.com",
				},
				body: body ? JSON.stringify(body) : undefined,
			});

		// POST
		const postRes = await handleViewsRequest(
			mkReq("POST", { slug: "t1", title: "T1", state: { limit: 50 } }),
			env,
			[],
		);
		expect(postRes.status).toBe(201);
		const posted = (await postRes.json()) as any;
		expect(posted.slug).toBe("t1");
		expect(posted.public_id).toBeDefined();

		// LIST
		const listRes = await handleViewsRequest(
			new Request("http://test/api/views", {
				headers: { "cf-access-authenticated-user-email": "test@example.com" },
			}),
			env,
			[],
		);
		const listed = (await listRes.json()) as any;
		expect(listed.views).toHaveLength(1);
		expect(listed.views[0].slug).toBe("t1");

		// DELETE
		const delRes = await handleViewsRequest(
			new Request("http://test/api/views/t1", {
				method: "DELETE",
				headers: { "cf-access-authenticated-user-email": "test@example.com" },
			}),
			env,
			["t1"],
		);
		expect(delRes.status).toBe(200);

		// LIST again → empty
		const listRes2 = await handleViewsRequest(
			new Request("http://test/api/views", {
				headers: { "cf-access-authenticated-user-email": "test@example.com" },
			}),
			env,
			[],
		);
		const listed2 = (await listRes2.json()) as any;
		expect(listed2.views).toHaveLength(0);
	});

	test("/api/snapshots returns empty runs initially then populated", async () => {
		const listReq = new Request("http://test/api/snapshots");
		const emptyRes = await handleSnapshotsRequest(listReq, env, []);
		const empty = (await emptyRes.json()) as any;
		expect(empty.runs).toEqual([]);

		// Insert a fake row
		db.query(
			"INSERT INTO snapshot_runs (run_id, created_at, node_count, edge_count, r2_key, status) VALUES (?, ?, ?, ?, ?, ?)",
		).run("2026-04-13-fake", Date.now(), 5, 7, "vault-snapshots/fake/s.jsonl", "persisted");

		const full = (await (await handleSnapshotsRequest(listReq, env, [])).json()) as any;
		expect(full.runs).toHaveLength(1);
		expect(full.runs[0].node_count).toBe(5);
	});

	test("writeVaultSnapshot serializes 5 real nodes + 7 edges (NOT 0 nodes)", async () => {
		const runId = await writeVaultSnapshot(env);
		expect(runId).toBeDefined();

		// Row in snapshot_runs
		const row = db
			.query("SELECT node_count, edge_count, status FROM snapshot_runs ORDER BY id DESC LIMIT 1")
			.get() as any;
		expect(row.status).toBe("persisted");
		// THIS is the critical assertion — under the broken LIKE filter this
		// would be 0 (all 8 rows including sentinels would match `LIKE '__%'` -- LIKE-OK: comment
		// so `NOT LIKE '__%'` returns 0). Under the fixed GLOB filter it -- LIKE-OK: comment
		// should return the 5 real nodes.
		expect(row.node_count).toBe(5);
		expect(row.edge_count).toBe(7);

		// Verify the R2 object contents have 5 node lines BEFORE the
		// ---EDGES--- separator.
		const store = (env.VAULT_SNAPSHOTS as any)._store;
		const keys = Array.from(store.keys()) as string[];
		expect(keys).toHaveLength(1);
		const obj = store.get(keys[0]!)!;
		const lines = obj.body.split("\n");
		const sepIdx = lines.findIndex((l: string) => l === "---EDGES---");
		expect(sepIdx).toBe(5); // 5 node lines before the separator
		// Every line before the separator must be a real node path (not a sentinel).
		for (let i = 0; i < sepIdx; i++) {
			const node = JSON.parse(lines[i]!);
			expect(node.path.startsWith("__")).toBe(false);
		}
	});

	test("writeVaultSnapshot pagination: 2500 nodes across 3 pages are serialized with no duplicates or gaps", async () => {
		// Codex PR #9 review flagged that the previous snapshot test had only
		// 5 nodes in the fixture, all fitting in one LIMIT 1000 page — the
		// while-true loop and `path > cursor` advancement in snapshots.ts:49-65
		// were effectively untested. Seed 2500 real nodes (plus the 3
		// existing sentinels from the base fixture) to force 3 pages and
		// verify: (a) all 2500 real rows appear, (b) no duplicates across
		// page boundaries, (c) no gaps at cursor handoff points, (d) sentinels
		// stay excluded across all pages.

		// Insert 2500 additional real rows with lexicographically sortable
		// paths so the cursor advancement is deterministic. Use "zz/" prefix
		// to ensure they sort AFTER the base-fixture real rows and don't
		// collide with any existing path.
		const pad = (n: number) => n.toString().padStart(5, "0");
		for (let i = 0; i < 2500; i++) {
			db.query(
				"INSERT INTO vault_nodes (path, title, note_type, folder, tags, modified_at, size) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(`zz/page-test-${pad(i)}`, `Page Test ${i}`, "note", "zz", "[]", "2026-04-13T00:00:00.000Z", 10);
		}

		const runId = await writeVaultSnapshot(env);
		expect(runId).toBeDefined();

		const row = db
			.query("SELECT node_count, edge_count, status FROM snapshot_runs WHERE run_id = ?")
			.get(runId) as any;
		expect(row.status).toBe("persisted");
		// Base fixture has 5 real + 3 sentinels. We added 2500. Expected
		// non-sentinel count = 5 + 2500 = 2505.
		expect(row.node_count).toBe(2505);
		expect(row.edge_count).toBe(7);

		// Read the R2 object and verify the node section.
		const store = (env.VAULT_SNAPSHOTS as any)._store;
		const keys = Array.from(store.keys()) as string[];
		const obj = store.get(keys[keys.length - 1]!)!;
		const lines = obj.body.split("\n").filter((l: string) => l.length > 0);
		const sepIdx = lines.findIndex((l: string) => l === "---EDGES---");
		expect(sepIdx).toBe(2505);

		// Parse all node lines and verify:
		// 1. Total count matches
		// 2. No duplicate paths (catches "cursor stuck at page boundary" bug
		//    where the same row is re-emitted across pages)
		// 3. No sentinels leak through
		// 4. All 2500 zz/page-test-NNNNN paths are present (catches "cursor
		//    skips over a row" bug at page boundary)
		const nodePaths = new Set<string>();
		const duplicates: string[] = [];
		for (let i = 0; i < sepIdx; i++) {
			const node = JSON.parse(lines[i]!);
			expect(node.path.startsWith("__")).toBe(false);
			if (nodePaths.has(node.path)) {
				duplicates.push(node.path);
			}
			nodePaths.add(node.path);
		}
		expect(duplicates).toEqual([]);
		expect(nodePaths.size).toBe(2505);

		// Explicit coverage of every zz/page-test-NNNNN path — catches gaps.
		for (let i = 0; i < 2500; i++) {
			expect(nodePaths.has(`zz/page-test-${pad(i)}`)).toBe(true);
		}

		// And the 5 base-fixture real paths are also there.
		expect(nodePaths.has("Concepts/ExampleProject")).toBe(true);
		expect(nodePaths.has("Concepts/VaultGraph")).toBe(true);
		expect(nodePaths.has("Projects/Phase3")).toBe(true);
		expect(nodePaths.has("Projects/Phase4")).toBe(true);
		expect(nodePaths.has("People/Alice")).toBe(true);
	});

	test("regression guard — raw LIKE '__%' query matches every real path (proves the bug is real)", async () => { // LIKE-OK: characterization test name
		// This test exists to LOCK the knowledge that SQLite LIKE '__%' is a -- LIKE-OK: comment
		// single-char-wildcard trap. If SQLite ever changes its LIKE semantics,
		// this test will fail and we'll re-evaluate. As long as it holds, the
		// GLOB fix is necessary and the grep gate in CI is valid.
		const likeCount = db
			.query("SELECT COUNT(*) AS n FROM vault_nodes WHERE path LIKE '__%'") // LIKE-OK: characterization test, proves bug
			.get() as any;
		// 3 sentinels + 5 real notes = 8 total, all ≥2 chars, all match.
		expect(likeCount.n).toBe(8);

		const notLikeCount = db
			.query("SELECT COUNT(*) AS n FROM vault_nodes WHERE path NOT LIKE '__%'") // LIKE-OK: characterization test, proves bug
			.get() as any;
		expect(notLikeCount.n).toBe(0);

		// Contrast: GLOB '__*' matches only the sentinel rows (literal underscores).
		const globCount = db
			.query("SELECT COUNT(*) AS n FROM vault_nodes WHERE path GLOB '__*'")
			.get() as any;
		expect(globCount.n).toBe(3);

		const notGlobCount = db
			.query("SELECT COUNT(*) AS n FROM vault_nodes WHERE path NOT GLOB '__*'")
			.get() as any;
		expect(notGlobCount.n).toBe(5);
	});
});
