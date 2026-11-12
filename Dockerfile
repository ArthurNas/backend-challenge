FROM oven/bun:1.4.4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig*.json .prettierrc.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN bun run build

EXPOSE 3000 3001
CMD ["bun", "dist/main.js"]
