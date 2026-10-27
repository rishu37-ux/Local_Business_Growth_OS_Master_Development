#!/usr/bin/env bash
# Verifies the mandatory project-memory documents exist and are non-empty,
# and that docs/ contains no obvious secret patterns. Not a substitute for a
# real secret scanner (to be added to CI in Phase 3).
set -euo pipefail
cd "$(dirname "$0")/.."

required=(
  PROJECT_MEMORY.md DECISION_LOG.md REQUIREMENTS_TRACEABILITY.md
  SECURITY_THREAT_MODEL.md CHANGELOG.md TEST_REPORT.md
  INTEGRATIONS_STATUS.md DEPLOYMENT_RUNBOOK.md NEXT_STEPS.md
)

fail=0
for f in "${required[@]}"; do
  if [[ -s "docs/$f" ]]; then
    echo "ok      docs/$f"
  else
    echo "MISSING docs/$f"
    fail=1
  fi
done

# Common credential shapes: private keys, AWS keys, GitHub/Slack/OpenAI/Anthropic/Google tokens,
# and literal assignments like password=..., api_key: "...".
pattern='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|(password|passwd|secret|api[_-]?key|access[_-]?token)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+_-]{8,}'
if grep -rEni -- "$pattern" docs CLAUDE.md; then
  echo "FAIL    possible secret found (see lines above)"
  fail=1
else
  echo "ok      no secret patterns found in docs/ or CLAUDE.md"
fi

exit "$fail"
