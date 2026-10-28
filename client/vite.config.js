import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En développement, le site (port 5173) envoie /api et /media vers le serveur Node (port 3000).
// Le navigateur ne voit ainsi qu'une seule adresse, ce qui évite les soucis de cookies.
const backend = process.env.BACKEND_URL || "http://127.0.0.1:3000";
const proxy = { "/api": backend, "/media": backend };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
