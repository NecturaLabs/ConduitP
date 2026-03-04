FROM oven/bun:1.3.9-alpine AS deps
WORKDIR /app

# Install server deps using workspace metadata only
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/*/package.json ./apps/
COPY packages/*/package.json ./packages/
COPY cli/package.json ./cli/
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @conduit/server

FROM oven/bun:1.3.9-alpine
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/package.json ./apps/server/package.json
COPY --from=deps /app/packages/shared/package.json ./packages/shared/package.json

# Copy server + shared source only
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json

RUN mkdir -p /app/data
EXPOSE 3443
CMD ["bun", "run", "apps/server/src/index.ts"]
