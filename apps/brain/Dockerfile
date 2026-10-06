# Go's service. Build context: the repo root (the pnpm workspace).
FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@go/brain..." build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/brain/dist/main.js"]
