#!/usr/bin/env bash
# Stremio Offline (hosted addon) on the shared Traefik edge.
#
#   bash deploy.sh init      write .env.compose from the template
#   bash deploy.sh deploy    pull, restart, wait for health, check the edge
#   bash deploy.sh verify    re-run the edge check against the live host
#   bash deploy.sh logs      follow the container's logs
#   bash deploy.sh down      stop the stack
#
# Run it from this directory, on the VM.
set -euo pipefail

cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[soffline]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }

ENV_FILE=".env.compose"
COMPOSE_FILE="compose.yaml"

# The id in the served manifest. The edge check below matches on this, not on a
# 200, because a misrouted request also returns 200 — with somebody else's page.
ADDON_ID="app.synpse.soffline"

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Read one value out of .env.compose without sourcing it: that file is written by
# an operator and by CI, and sourcing arbitrary text as shell is a way to run it.
env_value() {
  local key="$1" fallback="${2:-}" line
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  [[ -z "$line" ]] && { printf '%s' "$fallback"; return; }
  printf '%s' "${line#*=}"
}

require_files() {
  [[ -f "$ENV_FILE" ]] || err "$ENV_FILE is missing. Run: bash deploy.sh init"
  [[ -f "$COMPOSE_FILE" ]] || err "$COMPOSE_FILE is missing."
}

# The failure this catches is the expensive one. Compose would happily create a
# network of its own if the external one were absent — and a self-created network
# has no Traefik on it, so every request 404s at an edge that cannot see this
# container, with nothing in this stack's logs to say why.
require_edge_network() {
  local network
  network="$(env_value TRAEFIK_NETWORK synapse-edge)"

  if ! docker network inspect "$network" >/dev/null 2>&1; then
    err "Shared Traefik network '$network' does not exist on this host.
     The Synpse stack owns it. Bring that up first, or:
         docker network create $network
     Then confirm:
         docker network inspect $network
     If the edge is genuinely named something else, set TRAEFIK_NETWORK in $ENV_FILE."
  fi

  if ! docker ps --filter "network=$network" --filter "status=running" \
        --format '{{.Image}}' 2>/dev/null | grep -qi traefik; then
    warn "Network '$network' exists but no running Traefik container is attached.
      The container will start and nothing will route to it."
  else
    log "shared edge network '$network' is present, with Traefik on it"
  fi
}

init_files() {
  if [[ -f "$ENV_FILE" ]]; then
    log "$ENV_FILE already exists, left alone"
  else
    cp ".env.compose.example" "$ENV_FILE"; chmod 600 "$ENV_FILE"
    log "wrote $ENV_FILE from the template — edit it before deploying"
  fi
}

wait_for_health() {
  local id state
  log "waiting for the container to report healthy"
  for _ in $(seq 1 40); do
    id="$(compose ps -q addon 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo none)"
      case "$state" in
        healthy) log "container is healthy"; return 0 ;;
        unhealthy) compose logs --tail 40 addon; err "container went unhealthy" ;;
      esac
    fi
    sleep 3
  done
  compose logs --tail 40 addon
  err "container did not become healthy in time"
}

# Through Traefik, on the loopback, with the Host header the router matches on.
# `-k` because the origin certificate is Cloudflare's and is not trusted locally;
# that is expected here and is not a warning worth printing.
#
# This asserts on the BODY, not the status code. The specific thing that goes
# wrong on this edge is another router winning our host — see the priority note
# in compose.yaml — and that failure answers 200 with somebody else's HTML. A
# status check would call it a success and Stremio would call the addon broken.
check_edge() {
  local host url body
  host="$(env_value SOFF_PRIMARY_DOMAIN)"
  [[ -z "$host" ]] && { warn "SOFF_PRIMARY_DOMAIN not set; skipping the edge check"; return 0; }

  url="https://127.0.0.1/manifest.json"
  for _ in $(seq 1 20); do
    body="$(curl -fsS -k --max-time 5 -H "Host: $host" "$url" 2>/dev/null || true)"
    if [[ "$body" == *"\"$ADDON_ID\""* ]]; then
      log "Traefik routes $host to this container, and it serves the addon manifest"
      log "install URL: https://$host/manifest.json"
      return 0
    fi
    sleep 3
  done

  if [[ -n "$body" ]]; then
    warn "$host answered, but the response is not this addon's manifest.
      Another Traefik router is winning that host. Raise SOFF_ROUTER_PRIORITY in
      $ENV_FILE above every other router that matches it, and read the priority
      note in compose.yaml. First 200 characters of what came back:
      ${body:0:200}"
  else
    warn "Traefik did not answer for $host within a minute.
      Most often one of: the router rule does not match that host, or the
      certificate for that zone is not loaded in the Synpse stack's deploy/tls.yml."
  fi
}

case "${1:-deploy}" in
  init)
    init_files
    ;;

  deploy)
    require_files
    require_edge_network
    if [[ -n "${SOFF_GHCR_TOKEN:-}" ]]; then
      log "logging in to ghcr.io"
      printf '%s' "$SOFF_GHCR_TOKEN" | docker login ghcr.io -u "${SOFF_GHCR_USERNAME:-x}" --password-stdin >/dev/null
    fi
    log "pulling $(env_value SOFF_IMAGE):${SOFF_IMAGE_TAG:-$(env_value SOFF_IMAGE_TAG latest)}"
    compose pull
    compose up -d --remove-orphans
    wait_for_health
    check_edge
    # Stateless, so nothing is ever kept by pruning. Old image layers otherwise
    # accumulate on the VM one deploy at a time until the disk fills.
    docker image prune -f >/dev/null 2>&1 || true
    log "deployed"
    ;;

  verify) require_files; check_edge ;;
  logs)   require_files; compose logs -f --tail 100 addon ;;
  down)   require_files; compose down ;;
  config) require_files; compose config ;;
  *)      err "unknown command '${1}'. One of: init deploy verify logs down config" ;;
esac
