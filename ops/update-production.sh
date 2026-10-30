#!/usr/bin/env bash
set -Eeuo pipefail
live=/opt/solar_homepage
source_dir=${1:?GitHub source directory required}
backup_dir=${2:?Backup directory required}
[ "$(id -u)" = 0 ] || { echo 'Run as root'; exit 1; }
source_dir=$(realpath "$source_dir")
backup_dir=$(realpath "$backup_dir")
[ "$source_dir" != "$live" ]
for file in server.js package.json package-lock.json public/calculator.html public/js/calculator.js server/calculator-engine.js; do
  test -f "$source_dir/$file"
done
test -f "$live/pm2-start.js"
test -d "$live/.pm2"
tar -tzf "$backup_dir/site.tar.gz" > /dev/null
node --check "$source_dir/server.js"
node --check "$source_dir/server/calculator-engine.js"
node --check "$source_dir/public/js/calculator.js"
group=$(id -gn appuser)
pm2_app() { runuser -u appuser -- env PM2_HOME="$live/.pm2" pm2 "$@"; }
needs_install=0
if ! cmp -s "$source_dir/package.json" "$live/package.json" || ! cmp -s "$source_dir/package-lock.json" "$live/package-lock.json"; then needs_install=1; fi
rollback() {
  trap - ERR INT TERM
  set +e
  echo 'Update failed. Restoring backup.' >&2
  pm2_app stop solar_homepage
  failed="$backup_dir/failed-$(date +%Y%m%d-%H%M%S)"
  install -d -m 700 "$failed"
  for item in public server node_modules server.js package.json package-lock.json; do
    if [ -e "$live/$item" ]; then
      mv "$live/$item" "$failed/$item" || { echo 'Recovery move failed; manual recovery required' >&2; exit 1; }
    fi
  done
  if tar -xzf "$backup_dir/site.tar.gz" -C "$live"; then
    pm2_app restart solar_homepage
    echo 'Backup restored. Check PM2 and website.' >&2
  else
    echo 'Recovery failed; manual recovery required.' >&2
  fi
  exit 1
}
pm2_app stop solar_homepage
trap rollback ERR INT TERM
cp -a "$source_dir/public/." "$live/public/"
cp -a "$source_dir/server/." "$live/server/"
cp "$source_dir/server.js" "$source_dir/package.json" "$source_dir/package-lock.json" "$live/"
chown -R appuser:"$group" "$live/public" "$live/server"
chown appuser:"$group" "$live/server.js" "$live/package.json" "$live/package-lock.json"
if [ "$needs_install" = 1 ]; then
  runuser -u appuser -- sh -c 'cd /opt/solar_homepage && npm ci --omit=dev --no-audit --no-fund'
fi
pm2_app restart solar_homepage
healthy=0
check_dir=$(mktemp -d)
for attempt in 1 2 3 4 5; do
  if curl -fsS --connect-timeout 3 --max-time 10 "https://cienergy.co.kr/api/calculator/catalog?deploy=$(date +%s)" -o "$check_dir/catalog.json" &&
     node -e 'const d=require(process.argv[1]);if(!d.modules||!Array.isArray(d.inverters)||!d.inverters.length)process.exit(1)' "$check_dir/catalog.json"; then healthy=1; break; fi
  sleep 2
done
test "$healthy" = 1
trap - ERR INT TERM
pm2_app list
echo 'Update complete. Check calculator input guidance and default plan A in the browser.'
echo "Source: $source_dir"
echo "Backup: $backup_dir/site.tar.gz"
