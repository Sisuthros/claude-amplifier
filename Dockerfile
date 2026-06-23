# syntax=docker/dockerfile:1
# claude-amplifier — MCP server (stdio). Multi-stage build.
# better-sqlite3 is a native module, so the build stage needs a toolchain.

# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Native build deps for better-sqlite3 (python3 + make + g++).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install all deps (incl. dev) against the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript + copy dashboard static assets.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop dev dependencies so only runtime deps are carried to the final image.
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the built server and its production node_modules.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run as the non-root user provided by the base image.
USER node

# MCP servers communicate over stdio; the process IS the transport.
ENTRYPOINT ["node", "dist/index.js"]
