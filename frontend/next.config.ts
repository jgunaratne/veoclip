import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@astryxdesign/core", "@astryxdesign/theme-neutral"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8080/api/:path*",
      },
      {
        source: "/media/:path*",
        destination: "http://localhost:8080/media/:path*",
      },
      {
        source: "/uploads/:path*",
        destination: "http://localhost:8080/uploads/:path*",
      },
    ];
  },
};

export default nextConfig;
