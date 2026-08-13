import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev-tools indicator overlaps the admin sidebar's bottom-left
  // controls (and breaks e2e clicks); disable it in development.
  devIndicators: false,
};

export default nextConfig;
