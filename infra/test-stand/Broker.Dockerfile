FROM docker:29.4.0-cli@sha256:2efe7c8e806b35050def6ba1ba0ddad67b521a0a6d37f4910b3d88f11b495d03 AS docker_cli
FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
COPY broker.mjs /stand/broker.mjs
ENTRYPOINT ["/bin/sh", "-ec"]
CMD ["install -d -m 0750 -g \"$(id -g)\" \"$(dirname \"$FACADE_CONVERTER_SOCKET\")\"; if test -S \"$FACADE_CONVERTER_SOCKET\"; then rm -- \"$FACADE_CONVERTER_SOCKET\"; fi; exec node /stand/broker.mjs"]
