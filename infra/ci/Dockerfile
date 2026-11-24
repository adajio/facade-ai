FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl fonts-dejavu-core git libicu72 libkrb5-3 libssl3 \
       poppler-utils python3 python3-venv tesseract-ocr tesseract-ocr-eng zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ci-python \
    && /opt/ci-python/bin/pip install --no-cache-dir jsonschema==4.26.0
RUN mkdir /opt/runner \
    && curl --fail --silent --show-error --location --retry 2 \
       https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-arm64-2.338.2.tar.gz \
       --output /tmp/runner.tar.gz \
    && echo '670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945  /tmp/runner.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/runner.tar.gz -C /opt/runner \
    && rm /tmp/runner.tar.gz \
    && chown -R node:node /opt/runner
ENV PATH="/opt/ci-python/bin:${PATH}" NODE_DISABLE_COMPILE_CACHE=1
USER node
WORKDIR /opt/runner
ENTRYPOINT ["/bin/bash", "-c", "IFS= read -r jit; exec ./run.sh --jitconfig \"$jit\""]

FROM debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS proxy
RUN apt-get update \
    && apt-get install -y --no-install-recommends tinyproxy \
    && rm -rf /var/lib/apt/lists/*
COPY tinyproxy.conf hosts /etc/tinyproxy/
USER tinyproxy
ENTRYPOINT ["/usr/bin/tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
