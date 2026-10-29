import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      "@storyteller/api": resolve(__dirname, "../../libs/api/src/lib/GameAssetsApi.ts"),
      "@storyteller/tauri-utils": resolve(__dirname, "../../libs/tauri-utils/src/lib/FetchProxy.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["app/src/**/*.spec.{ts,tsx}"],
  },
});
