import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "..",
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      scope: "/",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webp,webmanifest}"],
      },
      registerType: "autoUpdate",
      injectRegister: null,
      manifest: {
        name: "Pulse",
        short_name: "Pulse",
        description: "A personal productivity tracker",
        theme_color: "#0b0e14",
        background_color: "#0b0e14",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/pulse-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/pulse-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
});
