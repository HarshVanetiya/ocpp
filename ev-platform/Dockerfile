FROM node:26-slim AS build
# Prisma's engine needs OpenSSL, which the slim image lacks
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
# Same pnpm as your PC (corepack is not in Node 26). Use the "packageManager" version in your root package.json.
RUN npm install -g pnpm@12.14.0
WORKDIR /app

# Copy only the package files first, so this install layer is cached until dependencies change
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# (web's package.json is only here so the lockfile matches; its code is never copied or installed)
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter "@ev/api..."

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/db packages/db
# Generate the Prisma client inside the image so it matches Linux, not your Windows machine
RUN pnpm --filter @ev/db exec prisma generate
RUN pnpm --filter @ev/api build

FROM node:26-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
