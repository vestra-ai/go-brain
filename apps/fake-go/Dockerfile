# The fake Go, built from the repo root so the workspace packages it uses (@go/contract, @go/sim) build with it.
FROM node:22-slim
WORKDIR /repo
RUN npm install -g pnpm@10.29.1
COPY . .
RUN pnpm install --frozen-lockfile --filter "@go/fake-go..."
RUN pnpm --filter "@go/fake-go..." run build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/fake-go/dist/main.js"]
