import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

export default function nextConfig(phase) {
  const isDevServer = phase === PHASE_DEVELOPMENT_SERVER;

  /** @type {import('next').NextConfig} */
  return {
    reactStrictMode: true,
    // Keep dev and build artifacts separate to avoid missing-chunk runtime errors
    // when "next dev" and "next build" run around the same time.
    distDir: isDevServer ? ".next-dev" : ".next",
  };
}
