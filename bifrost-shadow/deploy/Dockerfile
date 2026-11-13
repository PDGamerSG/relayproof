# The hosted RelayProof demo in one container: a Bifrost gateway built with the
# shadow plugin, the deterministic mock upstream (no provider keys), and the
# front door, the only public listener. Build from the repository root:
#
#   docker build -f bifrost-shadow/deploy/Dockerfile -t relayproof-demo .
#   docker run --rm -p 10000:10000 -e BIFROST_SETUP_TOKEN=change-me relayproof-demo
#
# Then: curl localhost:10000/api/shadow/summary

FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY bifrost-shadow ./bifrost-shadow
# Clone upstream Bifrost at the pinned commit, overlay the plugin, apply the
# patches and build the gateway (cgo, for the SQLite config store). CI runs the
# tests; the image build skips them.
RUN SKIP_UI=1 SKIP_TESTS=1 bifrost-shadow/scripts/setup.sh /src/bifrost
RUN mkdir -p /out \
 && cp /src/bifrost/tmp/bifrost-http /out/ \
 && cd /src/bifrost/examples/shadow-demo \
 && GOWORK=off CGO_ENABLED=0 go build -trimpath -o /out/ ./mockupstream ./loadgen ./frontdoor

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 demo
COPY --from=build /out/ /usr/local/bin/
COPY bifrost-shadow/deploy/gateway.json /etc/relayproof/config.json
COPY bifrost-shadow/deploy/entrypoint.sh /usr/local/bin/relayproof-demo
USER demo
ENV PORT=10000 WORK_DIR=/home/demo/gateway
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -sf "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["tini", "--", "relayproof-demo"]
