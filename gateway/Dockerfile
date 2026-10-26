FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/gateway .

FROM alpine:3.20
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/gateway /usr/local/bin/gateway
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://localhost:8080/healthz || exit 1
ENTRYPOINT ["gateway"]
