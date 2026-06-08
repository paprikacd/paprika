FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY go.mod main.go .
RUN CGO_ENABLED=0 go build -o /demo-app .

FROM alpine:3.19
RUN adduser -D -u 1000 appuser
COPY --from=builder /demo-app /demo-app
USER appuser
EXPOSE 8080
ENTRYPOINT ["/demo-app"]
