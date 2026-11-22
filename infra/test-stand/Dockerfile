# syntax=docker/dockerfile:1
FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
COPY dependencies/ ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund \
    && npm --prefix web ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY apps ./apps
COPY web ./web
RUN --network=none npm run build \
    && npm prune --omit=dev --offline --ignore-scripts --no-audit --no-fund

FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS core
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/modules ./src/modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY db/migrations ./db/migrations
USER node
ENTRYPOINT ["node"]

FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS reader-tools
RUN apt-get update \
    && apt-get -o Dpkg::Options::=--force-unsafe-io install -y --no-install-recommends \
       poppler-utils=22.12.0-2+deb12u3 tesseract-ocr=5.3.0-2 \
       tesseract-ocr-eng=1:4.1.0-2 tesseract-ocr-rus=1:4.1.0-2 fonts-dejavu-core=2.37-6 python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 reader-exec.py /usr/local/lib/facade/reader-exec.py
RUN for utility in pdfinfo pdftoppm pdftotext tesseract; do \
      ln -s /usr/local/lib/facade/reader-exec.py "/usr/local/bin/$utility"; \
    done

FROM reader-tools AS reader
WORKDIR /app
COPY --from=core /app/ ./
USER node
ENTRYPOINT ["node"]
