#!/usr/bin/env bash
# scripts/smoke-d1.sh
#
# Manual end-to-end smoke check for the cross-chapter ConversationState
# carry (D1). Runs three API calls in sequence and prints the relevant
# `crossChapter` block from each response so you can eyeball whether the
# seed is actually being read/persisted on the running dev server.
#
# Pre-req: a healthy local stack (worker + redis + next.js dev on :3100)
# and a book in the library with at least chapters 003 + 004 + 005.
#
# Usage:
#   E2E_BOOK_ID=<uuid> ./scripts/smoke-d1.sh
#
# Environment overrides:
#   BASE_URL       — default http://127.0.0.1:3100
#   E2E_BOOK_ID    — book UUID (falls back to the helpers.ts default)
#   CHAPTER_A      — default chapter003
#   CHAPTER_B      — default chapter004
#   CHAPTER_C      — default chapter005

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3100}"
BOOK_ID="${E2E_BOOK_ID:-ffa65ac0-4010-40ea-9239-2fcea39c848f}"
CHAPTER_A="${CHAPTER_A:-chapter003}"
CHAPTER_B="${CHAPTER_B:-chapter004}"
CHAPTER_C="${CHAPTER_C:-chapter005}"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }

attribute() {
  local chapter="$1"
  local r
  r="$(curl -fsS "${BASE_URL}/api/library/${BOOK_ID}/chapters/${chapter}/attribute")" || {
    red "  attribute request failed for ${chapter}"
    return 1
  }
  # Extract crossChapter via node (jq is assumed present but fallback is fine).
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "${r}" | jq '.crossChapter'
  else
    printf '%s\n' "${r}" \
      | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
                 console.log(JSON.stringify(d.crossChapter, null, 2));'
  fi
}

bold "Smoke — D1 cross-chapter ConversationState carry"
echo "  base : ${BASE_URL}"
echo "  book : ${BOOK_ID}"
echo "  ch A : ${CHAPTER_A}"
echo "  ch B : ${CHAPTER_B}"
echo "  ch C : ${CHAPTER_C}"
echo

# Step 0 — wipe any pre-existing seed via the Prisma client. Easiest path
# without a dedicated API endpoint is to do it via `tsx` so you don't
# have to start a separate script. If the file path doesn't exist, skip
# silently.
WIPE_PATH="$(dirname "$0")"
if [ -f "${WIPE_PATH}/backfill-conversation-state.ts" ]; then
  bold "[0/4] clear BookConversationState via backfill"
  BACKFILL_BOOK_ID="${BOOK_ID}" npx --prefix "$(dirname "${WIPE_PATH}")/.." tsx \
    "${WIPE_PATH}/backfill-conversation-state.ts" --clear-only || true
else
  echo "[0/4] (skipping wipe — backfill-conversation-state.ts not yet written;"
  echo "       manually delete the row in BookConversationState before re-running)"
fi

bold "[1/4] attribute ${CHAPTER_A} (expect seedReason=no-row)"
RESP="$(attribute "${CHAPTER_A}")"
echo "${RESP}"
echo "${RESP}" | grep -q '"seedReason": "no-row"' \
  && green "  ✓ seedReason=no-row as expected" \
  || red    "  ✗ seedReason is NOT no-row"

bold "[2/4] attribute ${CHAPTER_B} (expect seedReason=applied, seedFromChapterIndex = A's index)"
RESP="$(attribute "${CHAPTER_B}")"
echo "${RESP}"
echo "${RESP}" | grep -q '"seedReason": "applied"' \
  && green "  ✓ seedReason=applied as expected" \
  || red    "  ✗ seedReason is NOT applied"

bold "[3/4] attribute ${CHAPTER_C} (expect seedReason=applied, seedFromChapterIndex = B's index)"
RESP="$(attribute "${CHAPTER_C}")"
echo "${RESP}"
echo "${RESP}" | grep -q '"seedReason": "applied"' \
  && green "  ✓ seedReason=applied as expected" \
  || red    "  ✗ seedReason is NOT applied"

bold "[4/4] re-attribute ${CHAPTER_A} (expect seedReason=stale-chapter)"
RESP="$(attribute "${CHAPTER_A}")"
echo "${RESP}"
echo "${RESP}" | grep -q '"seedReason": "stale-chapter"' \
  && green "  ✓ seedReason=stale-chapter as expected (later ch was attributed; this ch is behind)" \
  || red    "  ✗ seedReason is NOT stale-chapter"

echo
green "Smoke complete. Compare each crossChapter block to the expectations."
