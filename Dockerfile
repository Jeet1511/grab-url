# ── Build stage ─────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────
# Chromium is required: the resolver opens every URL in a real,
# isolated headless browser session (playwright-core drives the
# system Chromium via URL_UNWRAPPER_CHROMIUM_PATH).
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    URL_UNWRAPPER_CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Portal credentials (.env is intentionally not in .dockerignore; runtime
# env vars injected by the platform always take precedence over dotenv).
COPY .env ./

EXPOSE 3000
CMD ["npm", "start"]
