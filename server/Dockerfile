# 构建上下文 = 仓库根目录（需要前端产物与种子数据），见 docker-compose.yml 的 context/dockerfile。
#   docker build -f server/Dockerfile -t ic-tarkov-web .
# 前端产物请先在本机执行：npm run web:build

# ---------- 依赖 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---------- 编译 ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci || npm install
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---------- 运行 ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    SEED_DIR=/app/seed \
    CLIENT_DIST=/app/client
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY server/package.json            ./package.json
COPY server/sql                     ./sql

# 静态前端与种子数据：不存在时服务端会给出告警并仅提供 API
COPY src-react/dist-web             /app/client
COPY src-tauri/resources            /app/seed

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "dist/index.js"]
