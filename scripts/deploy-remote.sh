#!/usr/bin/env bash
# Run as root on the deployment server. Publishing a commit never deploys it.
set -euo pipefail
umask 077
app=/opt/AgenticV3
service=agentic-v3
admin_service=agentic-v3-admin
account=agenticv3
check_only=false
if test "${1:-}" = '--check'; then check_only=true; shift; fi
ref=${1:-origin/main}
exec 9>/run/lock/agentic-v3-deploy.lock
flock -n 9 || { echo 'Another deployment is running.'; exit 1; }
as_app() { runuser -u "$account" -- "$@"; }
repo() { as_app git -C "$app" "$@"; }
test "$(id -u)" = 0 || { echo 'Run this script as root.'; exit 1; }
systemctl cat "$service" "$admin_service" > /dev/null
repo diff --quiet
repo diff --cached --quiet
test -z "$(repo ls-files --others --exclude-standard)" || { echo 'Untracked source exists on the server; preserve it before updating.'; exit 1; }
repo fetch origin
target=$(repo rev-parse --verify "${ref}^{commit}")
before=$(repo rev-parse HEAD)
repo merge-base --is-ancestor "$before" "$target" || { echo 'Ref is not a fast-forward; no code was replaced.'; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
candidate=/opt/AgenticV3-candidates/$stamp
backup=/opt/AgenticV3-backups/git-$stamp
install -d -m700 -o "$account" -g "$account" "$candidate"
repo archive "$target" | as_app tar -x -C "$candidate"
cp -a "$app/.harness-contract" "$candidate/.harness-contract"
cp "$app/.env" "$candidate/.env"
chmod 600 "$candidate/.env"
chown -R "$account:$account" "$candidate"
as_app npm ci --prefix "$candidate" --no-audit --no-fund
as_app bash -c 'cd "$1"; npm run check && npm run build && npm run build:admin' -- "$candidate"
# Old verification files remain in the private backup, never in either new build.
cd "$candidate"
ports=$(as_app node --import tsx --input-type=module -e 'import {loadLocalEnvironment,serverSettings} from "./server/config.ts"; import {createGatewayAuthentication} from "./server/auth.ts"; loadLocalEnvironment(); createGatewayAuthentication({production:true}); const s=serverSettings(); if(s.port===s.adminPort)throw new Error("Consumer and admin ports must differ."); console.log(s.port,s.adminPort);')
read -r consumer_port admin_port <<< "$ports"
as_app node --import tsx scripts/deploy-readiness.ts
if "$check_only"; then
  echo "Checked $target; candidate $candidate; live service and database were not changed."
  exit 0
fi
install -d -m700 "$backup"
repo bundle create - HEAD > "$backup/source.bundle"
printf '%s\n' "$before" > "$backup/previous-commit.txt"
systemctl stop "$service" "$admin_service"
trap 'systemctl start "$service" "$admin_service"; echo "Deployment interrupted; inspect backup: $backup" >&2' ERR
# Re-check after shutdown to fence an input that arrived between preparation and stop.
as_app node --import tsx scripts/deploy-readiness.ts
runuser -u postgres -- pg_dump -Fc agentic_v3_demo > "$backup/database.dump"
node --env-file=/root/agentic-v3-deploy-20261023/migration.env --import tsx scripts/migrate.ts
repo merge --ff-only "$target"
mv "$app/node_modules" "$backup/node_modules"
mv "$candidate/node_modules" "$app/node_modules"
mv "$app/dist" "$backup/dist"
mv "$candidate/dist" "$app/dist"
if test -d "$app/dist-admin"; then mv "$app/dist-admin" "$backup/dist-admin"; fi
mv "$candidate/dist-admin" "$app/dist-admin"
chown -R "$account:$account" "$app/dist" "$app/dist-admin"
systemctl start "$service" "$admin_service"
for attempt in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$consumer_port/health/ready" > "$backup/health.json" \
    && curl -fsS "http://127.0.0.1:$admin_port/health/ready" > "$backup/admin-health.json"; then
    echo "Deployed $target; previous commit $before; backup $backup"
    exit 0
  fi
  sleep 1
done
echo "Health check failed. Inspect both $service and $admin_service journals and backup $backup" >&2
exit 1
