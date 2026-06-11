FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM busybox:1.36 AS runner
WORKDIR /app
COPY --from=builder /app/out ./out
CMD ["httpd", "-f", "-p", "3000", "-h", "/app/out"]