FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://localhost:3002/healthz || exit 1
CMD ["node", "src/index.js"]
