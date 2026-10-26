FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://localhost:3001/healthz || exit 1
CMD ["node", "src/index.js"]
