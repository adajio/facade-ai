FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
LABEL org.opencontainers.image.title="Facade AI ODA DWG converter launcher"
COPY --chmod=0755 oda-converter.sh /usr/local/bin/facade-oda-convert
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/facade-oda-convert"]
