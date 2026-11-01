import { defineConfig } from "tsup";

// Production build: bundles src/ into dist/index.js (the Docker image runs this file).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  clean: true,
  // @ev/db is TypeScript source (main: ./src/index.ts) that plain node can't run,
  // so compile it into the bundle. Other packages (express, @prisma/client...) stay
  // external and are loaded from node_modules at runtime.
  noExternal: ["@ev/db"],
});
