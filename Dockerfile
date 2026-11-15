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
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/docs.db
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "server/index.ts"]
