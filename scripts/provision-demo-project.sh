#!/usr/bin/env bash
# Creates (or reuses) the Supabase demo project, writes its URL and keys into .env.local WITHOUT
# printing them, applies the schema and synthetic seed, and deploys the inbound SMS webhook.
# Prerequisite (owner): `npx supabase login`. Usage:
#   SUPABASE_ORG_ID=<org id> bash scripts/provision-demo-project.sh [project-name]
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${1:-fortune-ai-hq-demo}"
ORG="${SUPABASE_ORG_ID:?set SUPABASE_ORG_ID (see: npx supabase orgs list)}"
REGION="${SUPABASE_REGION:-us-east-1}"
ENVF=.env.local
touch "$ENVF" && chmod 600 "$ENVF"
SB="npx --no-install supabase"

# Set KEY=VALUE in .env.local without echoing the value (values may hold / + = characters).
setvar() {
  python3 - "$ENVF" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1:4]
lines = open(path).read().splitlines() if open(path).read() else []
lines = [l for l in lines if not l.startswith(key + '=')]
lines.append(f'{key}={value}')
open(path, 'w').write('\n'.join(lines) + '\n')
PY
}
getvar() { grep -E "^$1=" "$ENVF" | tail -1 | cut -d= -f2- || true; }

project_ref() {
  $SB projects list -o json 2>/dev/null | python3 -c "
import json, sys
name = sys.argv[1]
for p in json.load(sys.stdin):
    if p.get('name') == name: print(p.get('ref') or p.get('id')); break" "$NAME"
}

REF="$(project_ref)"
if [ -z "$REF" ]; then
  PW="$(getvar SUPABASE_DB_PASSWORD)"
  if [ -z "$PW" ]; then
    PW="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    setvar SUPABASE_DB_PASSWORD "$PW"
  fi
  echo "creating project $NAME in org $ORG ($REGION)…"
  $SB projects create "$NAME" --org-id "$ORG" --region "$REGION" --db-password "$PW" >/dev/null
  REF="$(project_ref)"
fi
[ -n "$REF" ] || { echo "could not find or create the project"; exit 1; }
setvar SUPABASE_PROJECT_REF "$REF"
echo "project ref: $REF"

echo "waiting for the project to be healthy…"
for _ in $(seq 1 60); do
  STATUS="$($SB projects list -o json 2>/dev/null | python3 -c "
import json, sys
for p in json.load(sys.stdin):
    if (p.get('ref') or p.get('id')) == sys.argv[1]: print(p.get('status', ''))" "$REF")"
  [ "$STATUS" = "ACTIVE_HEALTHY" ] && break
  sleep 10
done
[ "$STATUS" = "ACTIVE_HEALTHY" ] || { echo "project not healthy yet (status: $STATUS); rerun later"; exit 1; }

# Keys go straight from the CLI into .env.local; nothing is printed.
$SB projects api-keys --project-ref "$REF" -o json 2>/dev/null | python3 -c "
import json, sys
keys = {k.get('name'): k.get('api_key') for k in json.load(sys.stdin)}
key = keys.get('service_role') or keys.get('secret') or ''
open('/tmp/.fahq-sk', 'w').write(key)"
SERVICE_KEY="$(cat /tmp/.fahq-sk)"; rm -f /tmp/.fahq-sk
[ -n "$SERVICE_KEY" ] || { echo "could not read the service key"; exit 1; }
setvar SUPABASE_URL "https://$REF.supabase.co"
setvar SUPABASE_SERVICE_ROLE_KEY "$SERVICE_KEY"
setvar TWILIO_WEBHOOK_URL "https://$REF.supabase.co/functions/v1/inbound"
unset SERVICE_KEY
echo "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TWILIO_WEBHOOK_URL written to .env.local (values not shown)"

PW="$(getvar SUPABASE_DB_PASSWORD)"
$SB link --project-ref "$REF" --password "$PW" >/dev/null
echo "linked"
SUPABASE_DB_PASSWORD="$PW" $SB db push --linked --include-seed --yes
if [ "${SKIP_FUNCTIONS:-0}" = "1" ]; then
  echo "schema and seed pushed; webhook deploy skipped (SKIP_FUNCTIONS=1)"
  exit 0
fi
$SB functions deploy inbound --project-ref "$REF" --no-verify-jwt
$SB secrets set --project-ref "$REF" "TWILIO_WEBHOOK_URL=https://$REF.supabase.co/functions/v1/inbound" >/dev/null
echo
echo "done. Webhook: https://$REF.supabase.co/functions/v1/inbound"
echo "until the owner sets the Twilio auth token it answers 403 to everything:"
echo "  npx supabase secrets set --project-ref $REF TWILIO_AUTH_TOKEN=<auth token>"
