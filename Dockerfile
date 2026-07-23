# Sharpline recorder + terminal — a long-lived process that captures every trade
# from Polymarket and Kalshi into a persistent database and serves the UI/API.
#
# Debian slim (glibc) so better-sqlite3's prebuilt binary loads cleanly; build
# tools are included as a fallback in case it has to compile from source.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. tsx (a devDependency) runs the TS
# entrypoints directly, so we need the full dependency set, not --omit=dev.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The database lives on a mounted volume so it survives restarts and redeploys.
ENV DB_PATH=/data/sharpline.db
ENV PORT=3000
ENV MARKET_LIMIT=80
ENV NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3000

# `serve` records BOTH venues and serves the terminal + API. Use `npm run record`
# instead for a headless recorder with no HTTP surface.
CMD ["npm", "run", "serve"]
