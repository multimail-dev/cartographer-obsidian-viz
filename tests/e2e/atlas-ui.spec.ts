import { expect, test, type Page } from "@playwright/test";

type AtlasNode = {
  id: string;
  title: string;
  folder: string;
  nodeType: string;
  tags: string[];
  wordCount: number;
  pagerank: number;
  clusterId: number;
  componentId: number;
  clusteringCoeff: number;
  modified: number;
  created: number;
};

const now = Date.UTC(2026, 4, 22, 16, 30, 0);

const atlasNodes: AtlasNode[] = [
  {
    id: "atlas/memory",
    title: "Atlas Memory",
    folder: "atlas",
    nodeType: "concept",
    tags: ["memory", "systems"],
    wordCount: 842,
    pagerank: 0.172341,
    clusterId: 1,
    componentId: 1,
    clusteringCoeff: 0.4821,
    modified: Date.UTC(2026, 4, 20),
    created: Date.UTC(2026, 3, 18),
  },
  {
    id: "atlas/ritual",
    title: "Ritual Loop",
    folder: "atlas",
    nodeType: "idea",
    tags: ["ritual", "memory"],
    wordCount: 615,
    pagerank: 0.141992,
    clusterId: 1,
    componentId: 1,
    clusteringCoeff: 0.4113,
    modified: Date.UTC(2026, 4, 19),
    created: Date.UTC(2026, 3, 22),
  },
  {
    id: "atlas/identity",
    title: "Identity Scaffold",
    folder: "atlas",
    nodeType: "person",
    tags: ["identity", "systems"],
    wordCount: 701,
    pagerank: 0.109441,
    clusterId: 2,
    componentId: 1,
    clusteringCoeff: 0.3664,
    modified: Date.UTC(2026, 4, 18),
    created: Date.UTC(2026, 2, 30),
  },
  {
    id: "atlas/maps",
    title: "Map Pressure",
    folder: "research",
    nodeType: "research",
    tags: ["mapping", "analysis"],
    wordCount: 993,
    pagerank: 0.087119,
    clusterId: 2,
    componentId: 1,
    clusteringCoeff: 0.2988,
    modified: Date.UTC(2026, 4, 17),
    created: Date.UTC(2026, 1, 11),
  },
];

const atlasEdges = [
  { id: "1", sourceId: "atlas/memory", targetId: "atlas/ritual", edgeType: "wikilink", weight: 1 },
  { id: "2", sourceId: "atlas/memory", targetId: "atlas/identity", edgeType: "related", weight: 1 },
  { id: "3", sourceId: "atlas/ritual", targetId: "atlas/maps", edgeType: "claims", weight: 1 },
  { id: "4", sourceId: "atlas/identity", targetId: "atlas/maps", edgeType: "tag", weight: 1 },
];

const noteBodies: Record<string, string> = {
  "atlas/memory": [
    "# Atlas Memory",
    "",
    "Memory is the structural pressure that keeps the atlas coherent.",
    "",
    "## Why this matters",
    "",
    "- Links ritual to identity.",
    "- Reveals where context is over-concentrated.",
    "",
    "See also [[atlas/ritual]].",
  ].join("\n"),
  "atlas/ritual": "# Ritual Loop\n\nRitual compounds memory into habit.",
  "atlas/identity": "# Identity Scaffold\n\nIdentity clusters around repeated edges.",
  "atlas/maps": "# Map Pressure\n\nMapping pressure reveals bridge notes.",
};

async function installAtlasMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class NoopEventSource {
      addEventListener(): void {}
      close(): void {}
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: NoopEventSource,
    });
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/api/graph/nodes") {
      await json({
        items: atlasNodes.map((node) => ({
          id: node.id,
          title: node.title,
          folder: node.folder,
          nodeType: node.nodeType,
          frontmatter: { type: node.nodeType, tags: node.tags },
          tags: node.tags,
          wordCount: node.wordCount,
          created: node.created,
          modified: node.modified,
          contentHash: null,
          embeddingVersion: null,
          ingestRunId: null,
          x: null,
          y: null,
          body: null,
          pagerank: node.pagerank,
          clusterId: node.clusterId,
          componentId: node.componentId,
          clusteringCoeff: node.clusteringCoeff,
        })),
        nextCursor: null,
        total: atlasNodes.length,
      });
      return;
    }

    if (url.pathname === "/api/graph/edges") {
      await json({
        items: atlasEdges,
        nextCursor: null,
        total: atlasEdges.length,
      });
      return;
    }

    if (url.pathname === "/api/meta") {
      await json({
        nodeCount: atlasNodes.length,
        edgeCount: atlasEdges.length,
        edgeTypes: ["wikilink", "related", "claims", "tag"],
        topTags: [
          { tag: "memory", count: 2 },
          { tag: "systems", count: 2 },
        ],
        topFolders: [
          { folder: "atlas", count: 3 },
          { folder: "research", count: 1 },
        ],
        lastReload: now,
        enrichmentVersion: 7,
        lastEnrichmentAt: now,
        enrichmentCommunityCount: 2,
        lastIngestRunId: "ingest_01jv7f4m3x6w",
      });
      return;
    }

    if (url.pathname === "/api/enrichments") {
      await json({
        version: 7,
        lastRunAt: now,
        communityCount: 2,
        phase: "idle",
      });
      return;
    }

    if (url.pathname === "/api/enrichment/extended") {
      await json({
        betweenness: [0.422113, 0.301221, 0.188033, 0.077441],
        eigenvector: [0.633111, 0.488221, 0.366012, 0.244918],
        hubs: [0.611228, 0.451731, 0.318812, 0.219103],
      });
      return;
    }

    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const results = atlasNodes
        .filter((node) => {
          return (
            node.title.toLowerCase().includes(q) ||
            node.id.toLowerCase().includes(q) ||
            node.tags.some((tag) => tag.includes(q))
          );
        })
        .map((node) => node.id);
      await json({ results });
      return;
    }

    if (url.pathname === "/api/note") {
      const path = url.searchParams.get("path") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: noteBodies[path] ?? "# Missing note\n\nNo fixture exists for this path.",
      });
      return;
    }

    if (url.pathname === "/api/events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: ": e2e fixture\n\n",
      });
      return;
    }

    await route.fulfill({ status: 404, body: "not found" });
  });
}

async function gotoAtlas(page: Page, path = "/"): Promise<void> {
  await installAtlasMocks(page);
  await page.goto(path);
  await expect(page.locator("#status-summary")).not.toHaveText("Frontend failed to initialize.");
  await expect(page.locator("#meta-notes")).toHaveText(String(atlasNodes.length));
}

test("renders the Atlas shell and opens search with Cmd+K", async ({ page }) => {
  await gotoAtlas(page);

  await expect(page.locator("#empty-state")).toBeVisible();
  await expect(page.locator("#left-sidebar")).toHaveAttribute("aria-label", "Graph navigation");
  await expect(page.locator("#search-trigger")).toHaveAttribute("aria-label", "Search (Cmd+K)");
  await expect(page.locator("#canvas-controls")).toHaveClass(/hidden/);
  await expect(page.getByRole("heading", { name: "Search a note to reveal its structural neighborhood." })).toBeVisible();

  await page.keyboard.press("Meta+K");
  await expect(page.locator("#search-modal")).toBeVisible();
  await expect(page.locator("#search-modal")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#search-input")).toBeFocused();

  await page.locator("#search-input").fill("atlas/memory");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.locator("#search-modal")).toBeHidden();
  await expect(page.locator("#seed-focus-title")).toHaveText("Atlas Memory");
  await expect(page.locator("#detail-panel")).toBeVisible();
  await expect(page.locator("#detail-title")).toHaveText("Atlas Memory");
});

test("covers sidebar, detail panel, bottom dock, canvas controls, and Data Lab", async ({ page }) => {
  await gotoAtlas(page, "/?seed=atlas/memory&depth=2");

  await expect(page.locator("#view-tabs")).toBeVisible();
  await expect(page.locator("#canvas-controls")).toBeVisible();
  await expect(page.locator("#depth-slider")).toHaveValue("2");
  await expect(page.locator("#layout-select")).toHaveValue("fa3");
  await expect(page.locator("#left-sidebar")).toBeVisible();
  await expect(page.locator("#seed-focus-title")).toHaveText("Atlas Memory");

  await page.locator("#sidebar-toggle").click();
  await expect(page.locator("#left-sidebar")).toHaveClass(/collapsed/);
  await page.locator("#sidebar-toggle").click();
  await expect(page.locator("#left-sidebar")).not.toHaveClass(/collapsed/);

  await expect(page.locator("#detail-panel")).toBeVisible();
  await expect(page.locator("#detail-body")).toContainText("Memory is the structural pressure");
  await page.getByRole("tab", { name: "Neighbors" }).click();
  await expect(page.locator("#detail-body")).toContainText("Ritual Loop");
  await page.getByRole("tab", { name: "Note" }).click();
  await expect(page.locator("#detail-link")).toHaveText("Open in Obsidian");

  await expect(page.locator("#bottom-dock")).toBeVisible();
  await page.locator("#dock-toggle").click();
  await expect(page.locator("#dock-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".edge-legend-item")).toHaveCount(4);

  await page.locator("#tab-datalab").click();
  await expect(page.locator("#data-lab")).toBeVisible();
  await expect(page.locator("#datalab-tbody tr")).toHaveCount(4);
  await page.locator("#datalab-filter").fill("ritual");
  await expect(page.locator("#datalab-tbody tr")).toHaveCount(1);
  await expect(page.locator("#datalab-tbody tr")).toContainText("Ritual Loop");
  await page.locator('th[data-col="degree"]').click();
  await expect(page.locator('th[data-col="degree"]')).toHaveClass(/sort-asc|sort-desc/);
});

test("audits accessibility-facing CSS: dark color scheme, reduced motion, and contrast", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoAtlas(page, "/?seed=atlas/memory");

  const accessibilityState = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const motionTargets = ["#sigma-container", ".bottom-dock", ".toggle-chevron"].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, transitionDurationMs: null };
      const style = getComputedStyle(element);
      const firstDuration = style.transitionDuration.split(",")[0]?.trim() ?? "0s";
      const ms = firstDuration.endsWith("ms")
        ? Number.parseFloat(firstDuration)
        : Number.parseFloat(firstDuration) * 1000;
      return { selector, transitionDurationMs: Number.isFinite(ms) ? ms : 0 };
    });
    return {
      colorScheme: root.colorScheme,
      searchDialogName: document.getElementById("search-modal")?.getAttribute("aria-label"),
      detailRole: document.getElementById("detail-panel")?.getAttribute("role"),
      dockLabel: document.getElementById("bottom-dock")?.getAttribute("aria-label"),
      motionTargets,
    };
  });

  expect(accessibilityState.colorScheme).toBe("dark");
  expect(accessibilityState.searchDialogName).toBe("Search notes");
  expect(accessibilityState.detailRole).toBe("complementary");
  expect(accessibilityState.dockLabel).toBe("Edge legend");
  for (const target of accessibilityState.motionTargets) {
    expect(target.transitionDurationMs).not.toBeNull();
    expect(target.transitionDurationMs!).toBeLessThanOrEqual(1);
  }

  const contrastChecks = await page.evaluate(() => {
    const targets = [
      { selector: ".top-bar-search-hint", min: 4.5 },
      { selector: ".dock-blurb", min: 4.5 },
      { selector: "#datalab-table th", min: 4.5 },
      { selector: ".empty-lede", min: 4.5 },
      { selector: ".brand-lockup .brand-eyebrow", min: 4.5 },
    ];

    const srgbToLinear = (channel: number) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

    const relativeLuminance = ([r, g, b]: [number, number, number]) =>
      0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);

    const parse = (value: string): [number, number, number, number] => {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) throw new Error(`Unsupported color format: ${value}`);
      const parts = match[1].split(",").map((part) => part.trim());
      const toChannel = (raw: string) => {
        const normalized = raw.toLowerCase();
        if (normalized.endsWith("%")) return Number.parseFloat(normalized) / 100;
        return Number.parseFloat(normalized) / 255;
      };
      return [
        toChannel(parts[0]),
        toChannel(parts[1]),
        toChannel(parts[2]),
        parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
      ];
    };

    const flatten = (foreground: [number, number, number, number], background: [number, number, number, number]) => {
      const alpha = foreground[3];
      const nextAlpha = alpha + background[3] * (1 - alpha);
      const mix = (index: 0 | 1 | 2) =>
        (foreground[index] * alpha + background[index] * background[3] * (1 - alpha)) / (nextAlpha || 1);
      return [mix(0), mix(1), mix(2), nextAlpha] as [number, number, number, number];
    };

    const resolveBackground = (element: Element): [number, number, number, number] => {
      let current: Element | null = element;
      let composite: [number, number, number, number] = [0, 0, 0, 0];
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
          composite = flatten(parse(color), composite);
          if (composite[3] >= 0.999) return composite;
        }
        current = current.parentElement;
      }
      return flatten(parse(getComputedStyle(document.body).backgroundColor), composite);
    };

    return targets.map(({ selector, min }) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, min, ratio: 0, missing: true };
      const fg = parse(getComputedStyle(element).color);
      const bg = resolveBackground(element);
      const flattenedForeground = flatten(fg, bg);
      const light = Math.max(
        relativeLuminance([flattenedForeground[0], flattenedForeground[1], flattenedForeground[2]]),
        relativeLuminance([bg[0], bg[1], bg[2]])
      );
      const dark = Math.min(
        relativeLuminance([flattenedForeground[0], flattenedForeground[1], flattenedForeground[2]]),
        relativeLuminance([bg[0], bg[1], bg[2]])
      );
      return {
        selector,
        min,
        ratio: Number(((light + 0.05) / (dark + 0.05)).toFixed(2)),
        missing: false,
      };
    });
  });

  for (const check of contrastChecks) {
    expect(check.missing, `${check.selector} should exist for the contrast audit`).toBe(false);
    expect(check.ratio, `${check.selector} contrast ratio`).toBeGreaterThanOrEqual(check.min);
  }
});
