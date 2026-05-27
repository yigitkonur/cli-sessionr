#!/usr/bin/env bash
# verify-issues.sh — run the `## Verification` block of each agentic-issues/ entry
# against the current dist/cli.js, then report which issues are still_broken vs fixed.
#
# Usage:
#   scripts/verify-issues.sh                # all issues
#   scripts/verify-issues.sh CRITICAL       # only CRITICAL
#   scripts/verify-issues.sh CRITICAL HIGH  # CRITICAL + HIGH
#   scripts/verify-issues.sh oc/05          # one specific issue by path-glob
#
# Output: a markdown table to stdout with one row per issue + per-issue logs in .verify-runs/<ts>/.
# Exit code: 0 if at least one bug was probed; 2 on argument error.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR=".verify-runs/$TS"
mkdir -p "$RUN_DIR"

# Build first so dist/cli.js reflects current source
if [[ -z "${SKIP_BUILD:-}" ]]; then
  npm run build >/dev/null 2>&1 || { echo "build failed; abort"; exit 1; }
fi

# Make sessionr resolvable inside the verification block
SESSIONR_BIN="$ROOT/dist/cli.js"
chmod +x "$SESSIONR_BIN" 2>/dev/null || true
export PATH="$ROOT/scripts/shims:$PATH"
mkdir -p "$ROOT/scripts/shims"
cat > "$ROOT/scripts/shims/sessionr" <<EOF
#!/usr/bin/env bash
exec node "$SESSIONR_BIN" "\$@"
EOF
chmod +x "$ROOT/scripts/shims/sessionr"

# Filter by severity or path-glob
declare -a FILTERS=("$@")
match_filter() {
  local path="$1"
  [[ ${#FILTERS[@]} -eq 0 ]] && return 0
  for f in "${FILTERS[@]}"; do
    case "$f" in
      CRITICAL|HIGH|MEDIUM|LOW)
        [[ "$path" == *"-$f-"* ]] && return 0 ;;
      */*)
        [[ "$path" == *"/$f"* ]] && return 0 ;;
      *)
        [[ "$path" == *"$f"* ]] && return 0 ;;
    esac
  done
  return 1
}

# Extract the bash block under `## Verification` from a markdown file.
# We grab whatever is between the first ```bash fence after `## Verification`
# and the closing ``` fence.
extract_verification() {
  local md="$1"
  awk '
    BEGIN { in_section=0; in_fence=0 }
    /^## Verification/ { in_section=1; next }
    in_section && /^##[^#]/ { in_section=0 }
    in_section && /^```bash/ { in_fence=1; next }
    in_section && in_fence && /^```/ { in_fence=0; exit }
    in_section && in_fence { print }
  ' "$md"
}

# Header
printf '| Issue | Severity | Exit | Outcome | Log |\n'
printf '|---|---|---|---|---|\n'

count=0
while IFS= read -r md; do
  match_filter "$md" || continue
  count=$((count+1))

  # Derive a slug like "oc/05-CRITICAL-send-validation-bypasses-formatter"
  slug="$(echo "$md" | sed 's|agentic-issues/||; s|.md$||')"
  severity="UNKNOWN"
  for s in CRITICAL HIGH MEDIUM LOW; do
    [[ "$md" == *"-$s-"* ]] && severity="$s" && break
  done

  block_file="$RUN_DIR/$(echo "$slug" | tr '/' '_').sh"
  log_file="$RUN_DIR/$(echo "$slug" | tr '/' '_').log"

  verification="$(extract_verification "$md")"
  if [[ -z "$verification" ]]; then
    printf '| `%s` | %s | — | no_verification_block | — |\n' "$slug" "$severity"
    continue
  fi

  {
    echo '#!/usr/bin/env bash'
    echo '# auto-extracted from '"$md"
    echo 'set +e'  # do NOT exit on first failure; we want the full picture
    echo 'cd '"'$ROOT'"
    echo "$verification"
  } > "$block_file"
  chmod +x "$block_file"

  bash "$block_file" >"$log_file" 2>&1
  ec=$?

  # Heuristic outcome classification:
  # - jq -e in the block exits 0 when the assertion holds (the FIX is in place) and
  #   exits non-zero when it fails (i.e. the bug is still present).
  # - But many blocks are just demonstrations with "# expect ..." comments and no jq.
  #   In those cases we can't classify automatically; we mark `needs_review`.
  if grep -q 'jq -e' "$block_file"; then
    if [[ $ec -eq 0 ]]; then
      outcome="fixed"
    else
      outcome="still_broken"
    fi
  else
    outcome="needs_review"
  fi

  printf '| `%s` | %s | %s | %s | `%s` |\n' "$slug" "$severity" "$ec" "$outcome" "$log_file"
done < <(find agentic-issues -name '*.md' -not -path '*/_probes/*' | sort)

if [[ $count -eq 0 ]]; then
  echo
  echo "No issues matched the given filter(s)." >&2
  exit 2
fi

echo
echo "Run dir: $RUN_DIR"
