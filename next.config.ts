import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse pulls in pdfjs; keep it external so Next doesn't try to bundle it.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
