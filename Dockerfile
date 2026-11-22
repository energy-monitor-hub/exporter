# syntax=docker/dockerfile:1

# Base image pinned by tag AND digest. Update both by hand, to a tag older than 7 days.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base
WORKDIR /app
ENV NODE_ENV=production
# Local write queue (SQLite). Mount a volume here so queued rows survive container restarts.
ENV BUFFER_PATH=/data/buffer.sqlite
# Exporter login (OAuth tokens, secret) lives on the same volume.
ENV OAUTH_TOKEN_PATH=/data/oauth.json
# EcoFlow credentials from the status page's setup form, encrypted (key held by Supabase)
ENV CREDENTIALS_PATH=/data/credentials.json
# Signed decoder packs: last good index and packs (docs/DECODER_PACKS.md)
ENV DECODER_CACHE_DIR=/data/decoders
# node:sqlite is still flagged experimental in Node 22; the warning is noise.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
# Listen on all interfaces inside the container; compose publishes the ports on the host's
# 127.0.0.1 only. Published ports arrive from the bridge gateway, not from loopback, so the
# setup endpoints rely on the loopback Host check alone (UI_PEER_CHECK=off). Publish the
# ports on 127.0.0.1, never on all interfaces.
ENV LISTEN_HOST=0.0.0.0
ENV UI_PEER_CHECK=off
RUN mkdir -p /data && chown node:node /data
# Node 22 ships npm 10, which ignores `min-release-age` (.npmrc). Pin npm 11.
# npm-pin: npm
ARG NPM_VERSION=11.21.2
RUN npm install -g npm@${NPM_VERSION} && npm cache clean --force

# --- dev: all deps, tsx watch; source is synced in by `docker compose watch`
FROM base AS dev
ENV NODE_ENV=development
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
EXPOSE 9101
CMD ["npx", "tsx", "watch", "--clear-screen=false", "src/index.ts"]

# --- build: compile TypeScript
FROM dev AS build
RUN npm run build

# --- prod: runtime deps + compiled JS only
FROM base AS prod
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 9101
CMD ["node", "dist/index.js"]
