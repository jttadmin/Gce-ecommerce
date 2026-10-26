FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/cart-service .

FROM alpine:3.20
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/cart-service /usr/local/bin/cart-service
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://localhost:3003/healthz || exit 1
ENTRYPOINT ["cart-service"]
