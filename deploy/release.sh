#!/usr/bin/env bash
set -Eeuo pipefail
# Run from a staged release directory with the image loaded into Docker.
image=${1:?Expected image tag}
[[ "$image" =~ ^wacrm:[a-f0-9]{40}$ ]] || { echo 'Invalid image tag'; exit 1; }
root=/opt/wacrm
[[ -f "$root/.env.production" ]] || { echo 'Missing /opt/wacrm/.env.production'; exit 1; }
mkdir -p "$root/releases"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
release="$root/releases/${image#wacrm:}"
[[ ! -e "$release" ]] || { echo 'Release already exists; use a new commit or manually inspect the previous attempt'; exit 1; }
mkdir "$release"
cp compose.yml "$release/compose.yml"
ln -s "$root/.env.production" "$release/.env.production"
printf 'WACRM_IMAGE=%s\n' "$image" > "$release/.env"
previous=$(readlink -f "$root/current" 2>/dev/null || true)
rollback() {
  echo 'Deployment failed; restoring previous release.'
  if [[ -n "$previous" && -f "$previous/compose.yml" ]]; then
    docker compose --project-directory "$previous" -f "$previous/compose.yml" up -d --wait --wait-timeout 120 || echo 'ROLLBACK FAILED: operator attention required.'
  else
    docker compose --project-directory "$release" -f "$release/compose.yml" down || true
  fi
}
if ! docker compose --project-directory "$release" -f "$release/compose.yml" up -d --wait --wait-timeout 180; then
  rollback
  exit 1
fi
ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
echo "Healthy release: $image"
