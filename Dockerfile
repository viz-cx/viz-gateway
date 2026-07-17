# syntax=docker/dockerfile:1
# Multi-stage build. One image runs any service, chosen at runtime by $SERVICE.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
# ALL workspace roots must be present before `npm install` (workspace linking) and
# `npm run build` (tsc -b resolves every reference in tsconfig.json: packages, contracts,
# setup-viz, tools/e2e). Copying only packages+tools made tsc -b fail TS6053 on the missing
# contracts/setup-viz projects, so the image never built (BH1).
COPY packages ./packages
COPY contracts ./contracts
COPY setup-viz ./setup-viz
COPY tools ./tools
# npm ci (not install): a clean, reproducible install straight from package-lock.json, so the
# image is built from the exact tree CI validates instead of whatever `install` happens to
# resolve (BM5). Requires the lockfile to be in sync — enforced by CI's own `npm ci`.
RUN npm ci --no-audit --no-fund
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# Rotated logs go under the writable data volume (the non-root gw user owns /app/data, but
# NOT /app — a relative "./logs" resolves to /app and crashes on mkdir EACCES). Override per host.
ENV LOG_DIR=/app/data/logs
WORKDIR /app
# Non-root.
RUN addgroup -S gw && adduser -S gw -G gw
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
# node_modules holds workspace SYMLINKS (@gateway/contracts-ton -> ../contracts/ton, etc.);
# their targets must exist at runtime or a service require() hits a dangling link. gram-watcher
# imports @gateway/contracts-ton, so contracts is mandatory; setup-viz keeps every link intact.
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/setup-viz ./setup-viz
COPY --from=build /app/tools ./tools
# The committed federation manifest (2-of-3) travels with the image. Runtime reads
# FEDERATION_MANIFEST=./federation.json (config.ts) relative to WORKDIR /app; if it is
# absent, loadConfig() silently falls back to count-only 1-of-1 synthesis — a signer would
# register against the wrong operator set. Copied from the build CONTEXT (the build stage
# never needs it), so it is NOT gated behind .dockerignore's env/keystore excludes.
COPY federation.json ./federation.json
# Static site served at / and CORS allowlist (loaded at startup by the coordinator).
COPY site ./site
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data && chown -R gw:gw /app/data
USER gw
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
