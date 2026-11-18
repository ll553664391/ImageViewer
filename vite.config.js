import { defineConfig } from "vite";

// Tauri 不使用文件路由，构建为单页静态资源即可
export default defineConfig({
  // 防止 Vite 在构建产物中注入会与 Tauri 冲突的内容
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    // 资源全部内联到少量文件，便于 Tauri 打包
    assetsInlineLimit: 0,
  },
});
