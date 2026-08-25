import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "牆外探險｜台股研究站 v2",
    short_name: "牆外探險",
    description: "以官方資料與可驗證模型研究台股。",
    start_url: "/",
    display: "standalone",
    background_color: "#06100c",
    theme_color: "#07130f",
    orientation: "portrait-primary",
    lang: "zh-Hant",
    icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
