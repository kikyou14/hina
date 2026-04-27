import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  integrations: [
    react(),
    starlight({
      title: "Hina",
      description: "Distributed server monitoring system",
      favicon: "/images/favicon.png",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/kikyou14/hina",
        },
      ],
      // Chinese is the default locale and lives at the site root (`/`).
      // English content lives under `/en/`.
      locales: {
        root: {
          label: "简体中文",
          lang: "zh-CN",
        },
        en: {
          label: "English",
          lang: "en",
        },
      },
      sidebar: [
        {
          label: "开始使用",
          translations: { en: "Getting Started" },
          items: [{ slug: "guides/introduction" }],
        },
        {
          label: "部署 Server",
          translations: { en: "Deploying the Server" },
          items: [
            { slug: "deployment/overview" },
            { slug: "deployment/docker" },
            { slug: "deployment/from-source" },
            { slug: "deployment/configuration" },
            { slug: "deployment/reverse-proxy" },
            { slug: "deployment/uninstall-server" },
          ],
        },
        {
          label: "部署 Agent",
          translations: { en: "Deploying the Agent" },
          items: [{ slug: "deployment/agent" }, { slug: "deployment/uninstall-agent" }],
        },
        {
          label: "配置",
          translations: { en: "Configuration" },
          items: [
            { slug: "configuration/alerts" },
            { slug: "configuration/billing" },
            { slug: "configuration/agent-tags" },
          ],
        },
      ],
      lastUpdated: true,
      pagination: true,
    }),
  ],
});
