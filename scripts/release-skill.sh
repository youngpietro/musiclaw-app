#!/usr/bin/env bash
# release-skill.sh — Publish a new version of the BeatClaw skill.
#
# Usage:   ./scripts/release-skill.sh <new-version> "changelog one-liner"
# Example: ./scripts/release-skill.sh 1.40.0 "Add mood field; bump genre list."
#
# What it does (in order):
#   1. Sanity-check args, working tree, and current branch.
#   2. Verify the new version is strictly greater than CURRENT_VERSION.
#   3. Update CURRENT_VERSION + CHANGELOG in supabase/functions/get-skill/index.ts.
#   4. Commit and push to origin/main (triggers Vercel auto-deploy →
#      beatclaw.com/skill serves the new SKILL.md).
#   5. Redeploy the get-skill edge function so the version endpoint
#      returns the new version + changelog.
#   6. Publish to ClawHub (clawhub publish ./skills/beatclaw --version X).
#
# Single source of truth: skills/beatclaw/SKILL.md
# Both install paths (beatclaw.com/skill and clawhub install beatclaw) end up
# in sync after this script finishes.

set -euo pipefail

# ─── 1. ARGS ──────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <new-version> \"<changelog one-liner>\""
  echo "Example: $0 1.40.0 \"Add mood field; bump genre list.\""
  exit 1
fi

NEW_VERSION="$1"
CHANGELOG_TEXT="$2"

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be semver X.Y.Z (got: $NEW_VERSION)"
  exit 1
fi

# ─── 2. RUN FROM REPO ROOT ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

GET_SKILL_FILE="supabase/functions/get-skill/index.ts"
SKILL_DIR="./skills/beatclaw"

if [[ ! -f "$GET_SKILL_FILE" ]]; then
  echo "Error: $GET_SKILL_FILE not found. Run from repo root."
  exit 1
fi

if [[ ! -f "$SKILL_DIR/SKILL.md" ]]; then
  echo "Error: $SKILL_DIR/SKILL.md not found."
  exit 1
fi

# ─── 3. VALIDATE BRANCH + CLEAN TREE ──────────────────────────────────
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on: $CURRENT_BRANCH)"
  exit 1
fi

# Allow uncommitted changes ONLY in the skill folder + get-skill (those are
# what we're about to commit). Anything else dirty → abort.
DIRTY_FILES="$(git status --porcelain | awk '{print $2}' | grep -Ev "^(skills/beatclaw/|$GET_SKILL_FILE)" || true)"
if [[ -n "$DIRTY_FILES" ]]; then
  echo "Error: working tree has uncommitted changes outside skill/get-skill:"
  echo "$DIRTY_FILES"
  echo "Commit or stash them before running this script."
  exit 1
fi

# ─── 4. VERIFY VERSION IS GREATER ─────────────────────────────────────
CURRENT_VERSION="$(grep -E 'CURRENT_VERSION = "[0-9]+\.[0-9]+\.[0-9]+";' "$GET_SKILL_FILE" \
  | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"

if [[ -z "$CURRENT_VERSION" ]]; then
  echo "Error: could not read CURRENT_VERSION from $GET_SKILL_FILE"
  exit 1
fi

# semver greater-than check via sort -V
GREATEST="$(printf '%s\n%s\n' "$CURRENT_VERSION" "$NEW_VERSION" | sort -V | tail -1)"
if [[ "$NEW_VERSION" == "$CURRENT_VERSION" || "$GREATEST" != "$NEW_VERSION" ]]; then
  echo "Error: new version ($NEW_VERSION) must be greater than current ($CURRENT_VERSION)"
  exit 1
fi

echo "→ Bumping $CURRENT_VERSION → $NEW_VERSION"

# ─── 5. UPDATE get-skill SOURCE ───────────────────────────────────────
# Replace CURRENT_VERSION
sed -i.bak -E "s/CURRENT_VERSION = \"[0-9]+\.[0-9]+\.[0-9]+\";/CURRENT_VERSION = \"$NEW_VERSION\";/" "$GET_SKILL_FILE"

# Replace CHANGELOG line — assume it's `const CHANGELOG = "...";` on one or
# more lines. We rewrite to a single-line form for simplicity.
python3 - "$GET_SKILL_FILE" "$NEW_VERSION" "$CHANGELOG_TEXT" <<'PY'
import sys, re, pathlib
path, version, changelog = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
src = p.read_text()
# Match: const CHANGELOG = "..."; (possibly multi-line via concatenation)
# We replace the entire `const CHANGELOG = ...;` declaration with a single line.
new_decl = f'const CHANGELOG =\n  "v{version}: {changelog}";'
src2, n = re.subn(
    r'const\s+CHANGELOG\s*=\s*(?:"[^"]*"|\s|\\\n|\n)*?;',
    new_decl,
    src,
    count=1,
    flags=re.DOTALL,
)
if n == 0:
    print(f"ERROR: could not find CHANGELOG declaration in {path}", file=sys.stderr)
    sys.exit(1)
p.write_text(src2)
PY

rm -f "$GET_SKILL_FILE.bak"

echo "→ Updated $GET_SKILL_FILE"

# ─── 6. COMMIT + PUSH ─────────────────────────────────────────────────
git add "$GET_SKILL_FILE" skills/beatclaw/
COMMIT_MSG="Skill v$NEW_VERSION

$CHANGELOG_TEXT"
git commit -m "$COMMIT_MSG"

echo "→ Pushing to origin/main (Vercel will auto-deploy beatclaw.com/skill)"
git push origin main

# ─── 7. REDEPLOY EDGE FUNCTION ────────────────────────────────────────
echo "→ Redeploying get-skill edge function"
supabase functions deploy get-skill --project-ref alxzlfutyhuyetqimlxi

# ─── 8. PUBLISH TO CLAWHUB ────────────────────────────────────────────
echo "→ Publishing to ClawHub"
clawhub publish "$SKILL_DIR" --version "$NEW_VERSION"

# ─── 9. DONE ──────────────────────────────────────────────────────────
echo
echo "✓ Released BeatClaw skill v$NEW_VERSION"
echo "  • beatclaw.com/skill          — live (Vercel auto-deploy)"
echo "  • clawhub install beatclaw    — live (just published)"
echo "  • get-skill endpoint          — version $NEW_VERSION"
echo
echo "Verify with:"
echo "  curl -s https://alxzlfutyhuyetqimlxi.supabase.co/functions/v1/get-skill | python3 -m json.tool"
