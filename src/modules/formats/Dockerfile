# syntax=docker/dockerfile:1.7
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
ARG TARGETARCH

FROM scratch AS tika
ADD --checksum=sha256:f29d4e0d2cff1fc32396f6ac5ce436dfc7b19f9303d3b899e1f56fde85711c96 \
    https://repo.maven.apache.org/maven2/org/apache/tika/tika-app/3.3.3/tika-app-3.3.3.jar /tika-app.jar

FROM ${DEBIAN_IMAGE} AS office
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc fonts-dejavu-core default-jre-headless unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tika --chmod=0644 /tika-app.jar /opt/tika/tika-app.jar
RUN chmod 0755 /opt/tika
COPY converter.sh /usr/local/bin/facade-convert
USER 65534:65534
RUN --network=none test -x /opt/tika \
    && test -r /opt/tika/tika-app.jar \
    && java -Xmx128m -Djava.awt.headless=true -Dlog4j2.disableJmx=true -jar /opt/tika/tika-app.jar --version
ENTRYPOINT ["/usr/local/bin/facade-convert"]

FROM scratch AS libredwg-arm64
ADD --checksum=sha256:9564f3befabc1baca44747ce79f8caadbca774412846fccfa77e1e74d48f902f \
    https://github.com/JuliaBinaryWrappers/LibreDWG_jll.jl/releases/download/LibreDWG-v0.13.4+0/LibreDWG.v0.13.4.aarch64-linux-gnu.tar.gz /libredwg.tgz

FROM scratch AS libredwg-amd64
ADD --checksum=sha256:521216527b73f953c26c6202e972676ad14c8ad812fc15f9c4af31ae2681f0b4 \
    https://github.com/JuliaBinaryWrappers/LibreDWG_jll.jl/releases/download/LibreDWG-v0.13.4+0/LibreDWG.v0.13.4.x86_64-linux-gnu.tar.gz /libredwg.tgz

FROM libredwg-${TARGETARCH} AS libredwg-package

FROM --platform=${BUILDPLATFORM} ${DEBIAN_IMAGE} AS dwg-layout
COPY --from=libredwg-package /libredwg.tgz /tmp/libredwg.tgz
RUN mkdir -p /opt/libredwg \
    && tar -xzf /tmp/libredwg.tgz -C /opt/libredwg \
      bin/dwg2dxf bin/dwgread lib/libredwg.so.0.0.13 share/licenses/LibreDWG/COPYING \
    && ln -s libredwg.so.0.0.13 /opt/libredwg/lib/libredwg.so.0

FROM ${DEBIAN_IMAGE} AS dwg
LABEL org.opencontainers.image.title="Facade AI LibreDWG converter" \
      org.opencontainers.image.version="0.13.4+0" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/JuliaBinaryWrappers/LibreDWG_jll.jl/tree/LibreDWG-v0.13.4%2B0"
COPY --from=dwg-layout /opt/libredwg/ /opt/libredwg/
COPY converter.sh /usr/local/bin/facade-convert
ENV PATH="/opt/libredwg/bin:${PATH}" LD_LIBRARY_PATH="/opt/libredwg/lib"
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/facade-convert"]
