import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Honour BASE_URL so the same build serves correctly from a subpath
  // on GitHub Pages and from / in local dev.
  base: process.env["BASE_URL"] ?? "/",
  plugins: [react()],
  // poly2tri (used by the post-process triangulator) references
  // Node's `global`, which doesn't exist in the browser. Alias it
  // to globalThis at build time so the lib's UMD-style guard works.
  define: {
    global: "globalThis",
  },
  server: {
    // Out of the common dev-server range (3000 / 4200 / 5173 / 8080) so
    // bem doesn't fight other local projects for default ports.
    port: 6273,
    strictPort: true,
    open: false,
  },
});
