# Contributing to Cartographer

Thank you for your interest in contributing to Cartographer. This document covers the basics of how to get set up and submit changes.

## Getting Started

1. Fork and clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/cartographer.git
cd cartographer
```

2. Install dependencies:

```bash
bun install
```

3. Create a feature branch:

```bash
git checkout -b your-feature-name
```

## Running Tests

Run the full test suite before submitting a PR:

```bash
bash workers/vault-mcp/scripts/test.sh
```

The test runner uses grep-based partitioning to isolate tests that use `mock.module()` into separate processes (bun's module mocks are process-global and irreversible).

## Submitting a Pull Request

1. Ensure all tests pass locally.
2. The CI grep-gate must pass -- it checks for known anti-patterns (e.g., SQLite `LIKE '__%'` sentinel-filter footguns).
3. Keep PRs focused. One feature or fix per PR is preferred over large bundles.
4. Write a clear PR description explaining what changed and why.

## Code Style

- Follow existing patterns in the codebase. The main worker is a single-file architecture (`workers/vault-mcp/src/index.ts`) -- do not split it into multiple files without discussion.
- MCP tool descriptions must include boundary clauses: state what the tool does, what it does NOT do, any side effects, prerequisites, and when to use alternatives. Every `registerTool` description must include at least one "Does NOT" clause.
- Bearer auth goes through `verifyBearer()` -- individual endpoints should not re-check auth.
- Edge types are declared in `packages/vault-graph-contract/src/edge-types.ts`. Add new types there, not inline.

## Security

- Never commit `.dev.vars` or `.mcp.json` (both are in `.gitignore`).
- `workers_dev` must remain `false` in `wrangler.toml` to prevent `.workers.dev` subdomain exposure.
- All bearer token comparisons use `crypto.subtle.timingSafeEqual()`.

## Questions

Open an issue if you have questions about the codebase or want to discuss a larger change before implementing it.
