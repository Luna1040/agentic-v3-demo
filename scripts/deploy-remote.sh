#!/usr/bin/env bash
# Run as root on the deployment server. Publishing a commit never deploys it.
set -euo pipefail
umask 077
app=/opt/AgenticV3
service=agentic-v3
account=agenticv3
ref=${1:-origin/main}
exec 9>/run/lock/agentic-v3-deploy.lock
flock -n 9 || { echo 'Another deployment is running.'; exit 1; }
as_app() { runuser -u "$account" -- "$@"; }
repo() { as_app git -C "$app" "$@"; }
test "$(id -u)" = 0 || { echo 'Run this script as root.'; exit 1; }
repo diff --quiet
repo diff --cached --quiet
test -z "$(repo ls-files --others --exclude-standard)" || { echo 'Untracked source exists on the server; preserve it before updating.'; exit 1; }
repo fetch origin
target=$(repo rev-parse --verify "${ref}^{commit}")
before=$(repo rev-parse HEAD)
repo merge-base --is-ancestor "$before" "$target" || { echo 'Ref is not a fast-forward; no code was replaced.'; exit 1; }
if test "$before" = "$target"; then echo "Already deployed: $target"; exit 0; fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
candidate=/opt/AgenticV3-candidates/$stamp
backup=/opt/AgenticV3-backups/git-$stamp
install -d -m700 -o "$account" -g "$account" "$candidate"
install -d -m700 "$backup"
repo archive "$target" | as_app tar -x -C "$candidate"
cp -a "$app/.harness-contract" "$candidate/.harness-contract"
cp "$app/.env" "$candidate/.env"
chmod 600 "$candidate/.env"
chown -R "$account:$account" "$candidate"
if cmp -s "$candidate/package-lock.json" "$app/package-lock.json"; then
  as_app ln -s "$app/node_modules" "$candidate/node_modules"
  new_dependencies=false
else
  as_app npm ci --prefix "$candidate" --no-audit --no-fund
  new_dependencies=true
fi
as_app bash -c 'cd "$1"; npm run check && npm run build' -- "$candidate"
# Preserve private verification reports separately from public source assets.
if test -d "$app/dist/verification"; then cp -a "$app/dist/verification" "$candidate/dist/verification"; fi
cd "$candidate"
as_app node --import tsx scripts/deploy-readiness.ts
runuser -u postgres -- pg_dump -Fc agentic_v3_demo > "$backup/database.dump"
repo bundle create - HEAD > "$backup/source.bundle"
printf '%s\n' "$before" > "$backup/previous-commit.txt"
systemctl stop "$service"
trap 'systemctl start "$service"; echo "Deployment interrupted; inspect backup: $backup" >&2' ERR
# Re-check after shutdown to fence an input that arrived between preparation and stop.
as_app node --import tsx scripts/deploy-readiness.ts
node --env-file=/root/agentic-v3-deploy-20261023/migration.env --import tsx scripts/migrate.ts
repo merge --ff-only "$target"
if "$new_dependencies"; then
  mv "$app/node_modules" "$backup/node_modules"
  mv "$candidate/node_modules" "$app/node_modules"
fi
mv "$app/dist" "$backup/dist"
mv "$candidate/dist" "$app/dist"
chown -R "$account:$account" "$app/dist"
systemctl start "$service"
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:7081/health/ready > "$backup/health.json"; then
    echo "Deployed $target; previous commit $before; backup $backup"
    exit 0
  fi
  sleep 1
done
echo "Health check failed. Inspect journalctl -u $service and backup $backup" >&2
exit 1
