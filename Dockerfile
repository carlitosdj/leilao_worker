# ============================================================
# Stage 1: compila TypeScript (alpine puro — rápido)
# ============================================================
FROM node:22-alpine AS builder
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ============================================================
# Stage 2: runtime com browsers Playwright pré-instalados
# ============================================================
FROM mcr.microsoft.com/playwright:v1.53.0-jammy
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# só deps de produção
COPY package*.json ./
RUN npm ci --omit=dev

# JS compilado do stage 1
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
