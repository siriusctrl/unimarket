import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-charts": ["recharts"],
          "vendor-financial-chart": ["lightweight-charts"],
          "vendor-table": ["@tanstack/react-table"],
          "vendor-ui": [
            "@radix-ui/react-slot",
            "class-variance-authority",
            "clsx",
            "lucide-react",
            "tailwind-merge",
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.UNIMARKET_API_PROXY ?? "http://localhost:3100",
      "/health": process.env.UNIMARKET_API_PROXY ?? "http://localhost:3100",
      "/openapi.json": process.env.UNIMARKET_API_PROXY ?? "http://localhost:3100",
    },
  },
});
