FROM debian:bookworm-slim AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev libarchive-dev \
    && rm -rf /var/lib/apt/lists/*
COPY extractor.c /build/extractor.c
RUN gcc -O2 -Wall -Wextra -Werror /build/extractor.c -larchive -o /build/facade-extract

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libarchive13 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/facade-extract /usr/local/bin/facade-extract
ENV LC_ALL=C.UTF-8
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/facade-extract"]
