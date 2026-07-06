import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    server: {
        proxy: {
            "/agnes-outputs": {
                target: "https://platform-outputs.agnes-ai.space",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/agnes-outputs/, ""),
            },
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
