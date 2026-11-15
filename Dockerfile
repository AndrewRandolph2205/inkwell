# ---- build the client ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production deps + server source + built client ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 3000
# Database: set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (hosted), or DATABASE_PATH on a mounted volume.
# The server refuses to start in production with neither, rather than silently losing data.
CMD ["node", "--import", "tsx", "server/index.ts"]
