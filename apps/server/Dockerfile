# Pin to a specific image digest to prevent supply-chain attacks via tag mutation.
# To update: pull oven/bun:1.2-alpine, run `docker inspect --format='{{index .RepoDigests 0}}'`
# and replace the digest below. Also update the bun-version in CI workflows to match.
FROM oven/bun:1.3-alpine@sha256:32f1fcccb1523960b254c4f80973bee1a910d60be000a45c20c9129a1efcffee
RUN addgroup -g 1001 conduit && adduser -u 1001 -G conduit -s /bin/sh -D conduit
WORKDIR /app

# Copy manifests for dependency resolution
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY apps/landing/package.json ./apps/landing/
COPY apps/mobile/package.json ./apps/mobile/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY cli/package.json ./cli/

# Install deps — workspace symlinks are created here.
# --ignore-scripts prevents malicious postinstall hooks from executing during CI builds.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy shared package source (for @conduit/shared type resolution)
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/

# Copy server source
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.json ./apps/server/

# Bun runs TypeScript natively — no tsc build needed
# All @conduit/shared imports are `import type` (erased by Bun's transpiler)
RUN mkdir -p /app/data && chown -R conduit:conduit /app
USER conduit
EXPOSE 3443
CMD ["bun", "run", "apps/server/src/index.ts"]
