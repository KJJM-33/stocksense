import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "StockSense",
    short_name: "StockSense",
    description: "Household stock intelligence — tap, text, or scan.",
    start_url: "/",
    display: "standalone",
    background_color: "#0F1117",
    theme_color: "#0F1117",
    icons: [
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
