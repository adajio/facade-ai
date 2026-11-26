# syntax=docker/dockerfile:1.7
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

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
