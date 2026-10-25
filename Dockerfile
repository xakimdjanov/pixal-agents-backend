FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data LOG_DIR=/var/log/studio USE_BUILTIN_RIPGREP=0
# Agents run the Claude CLI, git and uv (for MCP servers such as mcp-atlassian) inside this container.
ARG CLAUDE_CODE_VERSION=2.1.310
RUN apk add --no-cache git openssh-client uv ripgrep libgcc libstdc++ \
 && npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /data /var/log/studio && chown -R node:node /data /var/log/studio && chmod 700 /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
