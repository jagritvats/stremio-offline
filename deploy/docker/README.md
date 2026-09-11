# Deploying the hosted addon

This lane publishes **`apps/addon-server`** at `https://soffline.synpse.app`, as a
Stremio addon installed by URL — the way Torrentio is installed.

It runs as its own Compose project on the Traefik edge the Synpse stack owns. It
never binds host ports and never handles a TLS certificate.

## What this does and does not deploy

| | |
|---|---|
| Deployed here | the addon manifest, the `stream` / `catalog` / `meta` endpoints, the configure page |
| **Not** deployed here | `apps/desktop-runtime`, `apps/android-runtime`, the download engine, any file anyone downloads |

That split is not a staging decision, it is the architecture. `DESIGN.md` §1: a
remote addon cannot persist files on someone's device and cannot run their
download engine. Hosting this half buys **installation** — one HTTPS URL instead
of a local process just to browse. The downloading and the offline playback stay
on the user's own machine, in the runtime.

So a person with only the hosted addon installed gets a working, installable
addon that currently returns empty stream lists. See "Current state" below.

## Prerequisites, once

1. **DNS.** A record for `soffline` in the `synpse.app` Cloudflare zone, pointing
   at the deploy VM, **proxied** (orange cloud). SSL/TLS mode for the zone must be
   **Full (strict)**.
2. **TLS.** Nothing to do. `soffline.synpse.app` is under `*.synpse.app`, which the
   Synpse stack's existing wildcard Origin Cert already covers. No new certificate,
   no `tls.yml` edit.
3. **The edge is up.** The Synpse stack owns Traefik and the `synapse-edge`
   network. `deploy.sh` refuses to run without it.

## GitHub configuration

Repository → Settings → Environments → **PROD**, plus repository secrets.

| Secret | Required | What it is |
|---|---|---|
| `VM_HOST` | yes | The deploy VM's hostname or IP |
| `VM_USER` | yes | The SSH login on that VM |
| `VM_SSH_KEY` | yes | Private half of a key authorised for `VM_USER` |
| `VM_SSH_HOST_KEY` | **strongly recommended** | The verified `ssh-keyscan <host>` line. Without it, every deploy trusts whatever answers on port 22 and hands it an SSH key |
| `COMPOSE_ENV` | optional | The whole `.env.compose`. Unset, the file already on the VM is kept |
| `VM_APP_DIR` | optional | Defaults to `/home/ubuntu/soffline/app` |

There is no `APP_ENV`, and nothing is missing. The hosted addon has no secrets:
no model key, no database, no install secret. Every per-user setting rides in
that user's own install URL.

The VM's address and key path are deliberately not written down here — this file
is committed. Keep them in your own uncommitted notes, as the ResidentOps lane
does.

## First deploy

Push to `main` and the workflow builds `linux/arm64`, pushes to GHCR, and
deploys. Before the first push, put `.env.compose` on the VM:

```bash
ssh <user>@<vm>
mkdir -p /home/ubuntu/soffline/app/deploy
cd /home/ubuntu/soffline/app/deploy
# after the first workflow run has uploaded the templates:
bash deploy.sh init
vi .env.compose          # set SOFF_IMAGE to your GHCR path
bash deploy.sh deploy
```

Or set the `COMPOSE_ENV` secret to the whole file and let CI write it.

## Verifying

`deploy.sh deploy` ends with an edge check, and `bash deploy.sh verify` re-runs it
on demand. It asserts on the **body**, not the status code, because the specific
thing that goes wrong here answers `200` with someone else's HTML:

```bash
curl -s https://soffline.synpse.app/manifest.json | head -c 200
```

Expect JSON whose `id` is `app.synpse.soffline`.

To install into Stremio: open `https://soffline.synpse.app/`, add a configured
source addon URL, and press **Install into Stremio**.

## Rolling back

Actions → *Build and deploy the hosted addon* → **Run workflow**, and give
`image_tag` a previous commit SHA. The build job is skipped and the VM is pointed
at that existing image. Nothing is lost by rolling back: the service is stateless.

## Troubleshooting

**The addon installs, then every request returns HTML.** Another Traefik router is
winning `soffline.synpse.app`. `SYNAPSE_HOST_RULE` has a documented default ending
in `HostRegexp(.+\.synpse\.app)`, which matches our host too. Raise
`SOFF_ROUTER_PRIORITY` above every router that also matches it — the default of
110 already clears both Synpse routers. The long comment in `compose.yaml`
explains the whole trap.

**Every request 502s.** The container is up but Traefik cannot reach it. Almost
always `HOST` was changed away from `0.0.0.0`, which makes the server listen on
container-loopback only.

**`deploy.sh` refuses to start.** The `synapse-edge` network is missing or Traefik
is not attached to it. Bring the Synpse stack up first.

**The build fails at `pnpm install --frozen-lockfile`.** A workspace member's
`package.json` was added or changed without committing the updated
`pnpm-lock.yaml`, or without adding its `COPY` line to the Dockerfile.

## Current state

`apps/addon-server` serves a real manifest and real routing. Its three resource
handlers return empty results on purpose, and will until `addon-core` and
`addon-proxy` exist and the spikes in `docs/SPIKES.md` pass. `DESIGN.md` §23 fixes
that order.

That is deliberate rather than unfinished: a stream entry served from this host
can only ever hand off to the local runtime, and returning download entries before
that handoff is proven (Spike 1) would put a button in front of people that
silently does nothing.
