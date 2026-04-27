import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type ProxyOptions, defineConfig } from "vite";

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"));

const apiOrigin = `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}`;
const wsOrigin = apiOrigin.replace(/^http/, "ws");

const preserveHost: ProxyOptions["configure"] = (proxy) => {
  proxy.on("proxyReqWs", (proxyReq, req) => {
    const host = req.headers.host;
    if (host) proxyReq.setHeader("host", host);
  });
};

export default defineConfig({
  plugins: [tailwindcss(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": apiOrigin,
      "/live": { target: wsOrigin, ws: true, configure: preserveHost },
      "/ws": { target: wsOrigin, ws: true, configure: preserveHost },
    },
  },
});
