#!/bin/bash
# End-to-end smoke test against a real repo and real models.
#   PI_MAIN=openai-codex/gpt-6-astra PI_WORKER=openai-codex/gpt-5.6-luna npm test
# Generates a 600-line file, asks the main model to read it whole, and asserts
# that the read was blocked and bulk_read answered via the worker.
set -euo pipefail
: "${PI_MAIN:?set PI_MAIN=provider/model (the expensive model)}"
: "${PI_WORKER:?set PI_WORKER=provider/model (the cheap worker)}"
PKG="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$HOME/.pi/agent/shunt.json"; BAK=""
[ -f "$CFG" ] && BAK=$(cat "$CFG")
trap '[ -n "$BAK" ] && printf "%s" "$BAK" > "$CFG" || rm -f "$CFG"; rm -rf "$TMP"' EXIT
printf '{"provider":"%s","model":"%s","minLines":350,"enabled":true}\n' "${PI_WORKER%%/*}" "${PI_WORKER#*/}" > "$CFG"

TMP=$(mktemp -d); cd "$TMP"
for i in $(seq 1 600); do echo "export const value$i = $i; // line $i"; done > big.ts
echo "export const MAGIC_NUMBER = 8675309;" >> big.ts

OUT=$(pi -p --no-session -ne -ns -e "$PKG" --model "$PI_MAIN" --mode json \
  "Read the whole file big.ts with the read tool (no grep, no offset/limit) and tell me the value of MAGIC_NUMBER." </dev/null)

grep -q '"toolName":"bulk_read"' <<<"$OUT" || { echo "FAIL: bulk_read never called"; exit 1; }
# The main model must never have received the file body (a blocked read is fine, a skipped read is better).
grep -oE '"toolName":"read"[^\n]*value300 = 300' <<<"$OUT" >/dev/null && { echo "FAIL: main model read the file directly"; exit 1; }
grep -q '8675309' <<<"$OUT"                || { echo "FAIL: answer missing MAGIC_NUMBER"; exit 1; }
echo "PASS: main model never read the file; bulk_read via $PI_WORKER answered, main $PI_MAIN never saw the file"
