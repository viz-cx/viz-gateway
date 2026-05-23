# syntax=docker/dockerfile:1
# Multi-stage build. One image runs any service, chosen at runtime by $SERVICE.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY tools ./tools
RUN npm install --no-audit --no-fund
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Non-root.
RUN addgroup -S gw && adduser -S gw -G gw
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/tools ./tools
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data && chown -R gw:gw /app/data
USER gw
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
