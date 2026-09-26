# Build stage
FROM node:22 AS builder

# Create app directory
WORKDIR /app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
#
# Note when using COPY with more than one source file, 
# the destination must be a directory and end with a /
# .npmrc: onnxruntime-node skips its CUDA download (the model runs on the CPU).
COPY package*.json .npmrc ./
COPY patches ./patches
RUN npm ci

COPY src ./src
COPY views ./views
COPY public ./public
COPY tsconfig*.json ./
COPY workbox-config.js .
COPY scripts ./scripts

# No .git in the build context: the CI publish job (.github/workflows/ci.yml) passes the commit so the
# static cache key (public/build.json) names it; the build time is the fallback.
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA

RUN npm run build

# Production stage
FROM node:22-slim

WORKDIR /app

COPY package*.json .npmrc ./
COPY patches ./patches
# Runtime dependencies only. Everything the running app serves from
# node_modules (htmx, background removal + models, onnxruntime-web, sharp,
# workbox-window) is in "dependencies", and so is patch-package, because the
# postinstall still has to apply patches/ here. The cache is cleared in the
# same layer: npm ci leaves hundreds of MB of tarballs under /root/.npm.
# onnxruntime-node (server-side background removal) ships binaries for six
# platforms; the image is linux/amd64 only, so the other five (~170 MB) go.
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v3/darwin \
    node_modules/onnxruntime-node/bin/napi-v3/win32 \
    node_modules/onnxruntime-node/bin/napi-v3/linux/arm64

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
# The migrations the app runs at boot (src/db/migrate.ts reads SQL and
# meta/_journal.json from <root>/drizzle).
COPY drizzle ./drizzle

COPY .env .

# The server-mode cutout model (MODELS_PATH, 940 MB) is not in the image: it
# is downloaded here on first need. Mount a local volume on it so it is
# fetched once (see README, Background removal).
RUN mkdir -p /app/models

# Set NODE_ENV to production
ENV NODE_ENV=production

EXPOSE 3000

# node itself is PID 1, so `docker stop`'s SIGTERM reaches main.ts, which
# closes the server and the database pool before exiting.
CMD [ "node", "dist/main.js" ]
