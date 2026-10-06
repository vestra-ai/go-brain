# The hosted "try Go" room (src/try-room), built from the repo root so @go/contract builds with it.
FROM node:22-slim
WORKDIR /repo
RUN npm install -g pnpm@10.29.1
COPY . .
RUN pnpm install --frozen-lockfile --filter "@go/sim..."
RUN pnpm --filter "@go/sim..." run build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "packages/sim/dist/try-room/main.js"]
