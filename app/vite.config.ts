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
      registerType: "autoUpdate",
      injectRegister: null,
      manifest: {
        name: "Pulse",
        short_name: "Pulse",
        description: "A personal productivity tracker",
        theme_color: "#f7f7f5",
        background_color: "#f7f7f5",
        display: "standalone",
        start_url: "/",
      },
    }),
  ],
});
