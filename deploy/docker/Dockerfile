# The hosted addon server, as one container.
#
# There is no compile step, on purpose. CLAUDE.md fixes that: packages export
# `./src/index.ts` directly and `tsx` runs TypeScript as-is, with `noEmit` set
# across the workspace. So `tsx` is a runtime dependency of apps/addon-server
# rather than a dev one — drop it from `dependencies` and the image builds fine
# and then fails to start.
#
# No `--platform` pin. The CI workflow builds linux/arm64 for the VM; a
# `docker build` on a laptop gets that laptop's architecture. Pinning here would
# break one of the two.
FROM node:22-alpine

# pnpm comes from the lockfile's `packageManager` field via corepack, so the
# version in the image always matches the version that wrote pnpm-lock.yaml.
RUN corepack enable

WORKDIR /app

# Manifests first, so editing a handler does not reinstall the world. Every
# workspace member's package.json has to be here before `pnpm install`, including
# the ones this image never runs: pnpm resolves the whole workspace against the
# lockfile, and a missing member makes `--frozen-lockfile` fail.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/models/package.json         packages/models/
COPY packages/addon-core/package.json     packages/addon-core/
COPY packages/addon-proxy/package.json    packages/addon-proxy/
COPY packages/download-core/package.json  packages/download-core/
COPY apps/desktop-runtime/package.json    apps/desktop-runtime/
COPY apps/addon-server/package.json       apps/addon-server/

RUN pnpm install --frozen-lockfile

# Source. apps/desktop-runtime is deliberately NOT copied: it is the local
# runtime, it binds 127.0.0.1, and it owns the privileged `/api/*` surface. None
# of that belongs on a public host.
COPY packages ./packages
COPY apps/addon-server ./apps/addon-server

ENV NODE_ENV=production \
    PORT=7000 \
    HOST=0.0.0.0

# Nothing is written at runtime — no database, no downloads, no config store —
# so the process needs no write access and no privileges. The workspace files
# stay root-owned and world-readable, which is all this user needs.
USER node

WORKDIR /app/apps/addon-server

EXPOSE 7000

# `/health` and not `/manifest.json`: the manifest is built from a constant and
# would answer even if routing were broken. busybox wget, because the node image
# is alpine-based and carries no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:7000/health || exit 1

# `node --import tsx` rather than `pnpm start`, so this process is PID 1 and
# receives SIGTERM directly. Behind pnpm it would not, and every deploy would
# hard-kill the container after the grace period instead of closing cleanly.
CMD ["node", "--import", "tsx", "src/main.ts"]
