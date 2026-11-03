import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    // Required by @cloudflare/vite-plugin.
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
