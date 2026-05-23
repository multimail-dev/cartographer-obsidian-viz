#!/usr/bin/env bash
#
# Replaces the literal `__SOURCE_COMMIT_SHA__` placeholder in $TARGET with a
# markdown link to https://github.com/$REPO/commit/$SOURCE_SHA, then verifies
# the substitution actually happened (fails the script if not).
#
# Used by .github/workflows/publish-sync-engine.yml to inject the cartographer
# commit SHA into packages/sync-engine/README.md before `bun publish`.
#
# Env-var contract (Sharp Directive #2 — pre-export precedence):
# - SOURCE_SHA, REPO, and TARGET MUST be non-empty in the script's
#   environment. The `: "${VAR:?...}"` expansions fail loudly if any of
#   them is unset OR empty.
# - The script CANNOT verify at runtime whether a value came from an
#   explicit caller-provided env (e.g. workflow `env:` block,
#   `execFileSync({env})`) versus an inherited shell export. It only
#   checks that the value is present.
# - Precedence ("explicit caller env wins over pre-existing inherited
#   shell exports") is a property of the CALLER's invocation pattern,
#   not of this script. The workflow uses GitHub Actions step-level
#   `env:`, which the runner guarantees overrides job/workflow/runner
#   defaults. The Bun test invokes via execFileSync's `env` option,
#   which replaces the child process env entirely.
# - That precedence property is verified by tests/inject-source-sha.test.ts
#   ("explicit SOURCE_SHA wins over a pre-existing inherited value"),
#   which pre-sets SOURCE_SHA in the test process and proves the explicit
#   value reaches the script.

set -euo pipefail

: "${SOURCE_SHA:?SOURCE_SHA must be set explicitly by the caller}"
: "${REPO:?REPO must be set explicitly by the caller (e.g. owner/name)}"
: "${TARGET:?TARGET must be set to the path of the README to update}"

if [[ ! -f "${TARGET}" ]]; then
  echo "TARGET file not found: ${TARGET}" >&2
  exit 1
fi

REPLACEMENT="[\\\`${SOURCE_SHA}\\\`](https://github.com/${REPO}/commit/${SOURCE_SHA})"

# sed -i with .bak suffix is portable across BSD (macOS) and GNU sed.
sed -i.bak "s|__SOURCE_COMMIT_SHA__.*|${REPLACEMENT}|" "${TARGET}"
rm -f "${TARGET}.bak"

if ! grep -q "${SOURCE_SHA}" "${TARGET}"; then
  echo "Source-SHA injection failed — ${TARGET} does not contain ${SOURCE_SHA}" >&2
  exit 1
fi

if grep -q "__SOURCE_COMMIT_SHA__" "${TARGET}"; then
  echo "Source-SHA injection incomplete — placeholder still present in ${TARGET}" >&2
  exit 1
fi

echo "Source-SHA injection OK: ${TARGET} now references ${SOURCE_SHA}"
