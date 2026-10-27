# syntax=docker/dockerfile:1.7
# DojoHub — single image with three entrypoints: server | worker | migrate (and `all` for single-container mode).
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @dojohub/web build && pnpm --filter @dojohub/server build
RUN pnpm --filter @dojohub/server deploy --prod --legacy /out \
 && cp -r apps/server/dist /out/dist \
 && cp -r apps/web/dist /out/web \
 && cp -r packages/db/drizzle /out/drizzle

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# git is required to serve skills over git smart-HTTP and to clone upstream sources.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/blobs /data/git /data/work && chown -R node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /out /app
ENV NODE_ENV=production \
    PORT=3000 \
    DOJO_WEB_DIST=/app/web \
    DOJO_MIGRATIONS_DIR=/app/drizzle \
    STORAGE_PATH=/data/blobs \
    DOJO_GIT_CACHE_DIR=/data/git \
    DOJO_WORK_DIR=/data/work
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--enable-source-maps", "dist/main.mjs"]
CMD ["server"]

LABEL org.opencontainers.image.title="DojoHub" \
      org.opencontainers.image.description="Self-hosted, enterprise-grade registry for AI agent skills" \
      org.opencontainers.image.source="https://github.com/axiomat/dojohub" \
      org.opencontainers.image.licenses="Apache-2.0"
