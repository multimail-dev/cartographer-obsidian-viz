#!/bin/bash
# Split test runs to avoid mock.module() pollution between test files.
# bun's mock.module() is process-global and irreversible — no mock.restore()
# for module mocks. Running all test files in one process means any file that
# calls mock.module() poisons the registry for files that need real modules.
# Fix: isolate mock.module users into their own bun test process.

set -euo pipefail
cd "$(dirname "$0")/.."

# Group A: files that use mock.module() (directly or via pr2-harness)
MOCK_DIRECT=$(grep -rl 'mock\.module' tests/ | grep '\.test\.ts$' || true)
MOCK_HARNESS=$(grep -rl 'pr2-harness' tests/ | grep '\.test\.ts$' || true)
MOCK_FILES=$(printf '%s\n%s' "$MOCK_DIRECT" "$MOCK_HARNESS" | sort -u | grep -v '^$')

# Group B: everything else (needs real modules, clean registry)
ALL_FILES=$(find tests -name '*.test.ts' | sort)
CLEAN_FILES=$(comm -23 <(echo "$ALL_FILES") <(echo "$MOCK_FILES"))

CLEAN_COUNT=$(echo "$CLEAN_FILES" | wc -l | tr -d ' ')
MOCK_COUNT=$(echo "$MOCK_FILES" | wc -l | tr -d ' ')

echo "=== Run 1: clean tests ($CLEAN_COUNT files, no mock.module) ==="
bun test $CLEAN_FILES

echo ""
echo "=== Run 2: mock.module tests ($MOCK_COUNT files, isolated) ==="
bun test $MOCK_FILES
