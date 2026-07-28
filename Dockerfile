FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/extension/package.json apps/extension/package.json
RUN npm ci \
  --workspace @calllog/shared \
  --workspace @calllog/web \
  --workspace @calllog/worker \
  --include-workspace-root

COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/worker apps/worker
RUN npm run build -w @calllog/shared \
  && npm run build -w @calllog/web \
  && npm run build -w @calllog/worker \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/nbleicher/cauli" \
  org.opencontainers.image.revision="${VCS_REF}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
