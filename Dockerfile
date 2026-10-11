# Resume Editor: Node app + tectonic (LaTeX) + poppler (pdftotext/pdfinfo) + git.
# The container is the sandbox for LaTeX compiles (there is no macOS sandbox-exec here),
# so it runs as an unprivileged user; don't mount anything sensitive into it.

# --- Stage 1: build the CodeMirror editor bundle (needs dev deps) ---
FROM node:24-alpine AS editor
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY editor ./editor
RUN npm run build:editor --silent

# --- Stage 2: production node_modules only (no dev, no optional native canvas) ---
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
 # pdfjs: the browser loads only pdf.min.mjs, pdf.worker.min.mjs, and web/pdf_viewer.css
 && rm -rf node_modules/pdfjs-dist/legacy node_modules/pdfjs-dist/image_decoders \
 && find node_modules/pdfjs-dist/build -type f ! -name "*.min.mjs" -delete \
 # type definitions, source maps, and docs aren't needed at runtime
 && find node_modules \( -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" -o -name "*.map" -o -name "*.md" -o -name "*.markdown" \) -type f -delete

# --- Stage 3: runtime ---
FROM node:24-alpine
ARG TECTONIC_VERSION=0.17.0
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000 \
    XDG_CACHE_HOME=/opt/tectonic-cache

RUN apk add --no-cache poppler-utils git curl \
 # npm and corepack aren't used at runtime
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*

# tectonic: static musl binary from the GitHub release, picked by architecture
RUN set -eux; \
    case "$(uname -m)" in x86_64) t=x86_64-unknown-linux-musl ;; aarch64) t=aarch64-unknown-linux-musl ;; *) echo "unsupported arch" && exit 1 ;; esac; \
    curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${t}.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic; \
    tectonic --version

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY template ./template
COPY scripts ./scripts
# Optional private overlay (billing); the glob makes the COPY a no-op when the folder is absent.
COPY privat[e] ./private
COPY --from=editor /app/public/vendor ./public/vendor

# Warm tectonic's package cache by compiling the template once, so the first real
# compile doesn't download ~100 MB of TeX packages at runtime.
RUN mkdir -p "$XDG_CACHE_HOME" && cd /tmp && cp /app/template/template.tex warm.tex \
 && tectonic --chatter minimal warm.tex && rm -f warm.* \
 && chown -R node:node "$XDG_CACHE_HOME"

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://localhost:3000/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
