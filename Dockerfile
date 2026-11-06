FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Headless Chromium (and fonts) to make proposal PDFs on the server
RUN apk add --no-cache chromium font-noto ttf-freefont
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Dependencies first so they are cached between builds
COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm ci --omit=dev --no-audit --no-fund

# Site files and API code (secrets and dev files are excluded by .dockerignore)
COPY index.html ./index.html
COPY assets ./assets
COPY tool ./tool
COPY api ./api

RUN chown -R node:node /app
USER node

WORKDIR /app/api
ENV PORT=4400
EXPOSE 4400

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4400/api/health || exit 1

CMD ["node", "server.js"]
