FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

# 页面构建（构建期即校验页面，产物供运行时优先伺服）
RUN node scripts/build.js

EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
