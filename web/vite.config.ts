import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 前端产物随 Python 包发布，服务端直接静态托管 dist/（见 CONTRACT §2）。
// base 用相对路径，使产物可挂在 / 或任意子路径下；路由走 hash，不需要服务端 rewrite。
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    target: "es2020",
    sourcemap: false,
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  preview: { host: "127.0.0.1", port: 4173 },
});
