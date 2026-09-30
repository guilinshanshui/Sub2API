FROM node:22.19-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/web/package.json apps/web/package.json
COPY vendor/deepseek-harness-codearts/package.json vendor/deepseek-harness-codearts/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN pnpm build

FROM base AS runtime

ENV NODE_ENV=production
ENV SUB2API_HOST=0.0.0.0
ENV SUB2API_PORT=8787
ENV SUB2API_DATA_DIR=/app/data
ENV SUB2API_WEB_DIST=/app/apps/web/dist

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/web/package.json apps/web/package.json
COPY vendor/deepseek-harness-codearts/package.json vendor/deepseek-harness-codearts/package.json

RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY --from=build /app/apps/gateway/dist apps/gateway/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/vendor/deepseek-harness-codearts/lib vendor/deepseek-harness-codearts/lib
COPY --from=build /app/vendor/deepseek-harness-codearts/locale vendor/deepseek-harness-codearts/locale
COPY --from=build /app/vendor/deepseek-harness-codearts/cordis.patch.yml vendor/deepseek-harness-codearts/cordis.patch.yml

RUN mkdir -p /app/data && chown -R node:node /app

USER node

VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "apps/gateway/dist/index.js"]
