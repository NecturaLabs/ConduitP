FROM oven/bun:1.3.9-alpine
WORKDIR /app

# Copy root workspace config + lockfile
COPY package.json bun.lock ./

# Copy ALL workspace package.json files to preserve workspace layout
# (globs flatten directory structure in Docker COPY, so we must be explicit)
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/landing/package.json ./apps/landing/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY cli/package.json ./cli/package.json

# Install only server + shared deps (no frozen-lockfile — bun workspace
# filtering can cause lockfile drift detection even when nothing changed)
RUN bun install --production --ignore-scripts --filter @conduit/server

# Copy server + shared source only
COPY apps/server/src ./apps/server/src
COPY packages/shared/src ./packages/shared/src

RUN mkdir -p /app/data
EXPOSE 3443
CMD ["bun", "run", "apps/server/src/index.ts"]
