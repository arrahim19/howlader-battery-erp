/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS entry point loaded by Metro. */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
// Keep native Gradle work and the DOM/native Metro bundles within the PC's resources.
config.maxWorkers = 4;
const web = path.resolve(__dirname, "../web/src");
const adapters = path.resolve(__dirname, "src/shared-web");
config.resolver.resolveRequest = (context, name, platform) => {
  const aliases = {
    "next/link": "link.tsx",
    "next/navigation": "navigation.tsx",
    "next/image": "image.tsx",
    "@/lib/api": "api.ts",
    "@/lib/invoice-image": "invoice-image.ts",
    "@/lib/brand-image": "brand-image.ts",
    "@/lib/print-document": "print-document.ts",
    "@/components/session-provider": "session.tsx",
  };
  if (aliases[name]) name = path.join(adapters, aliases[name]);
  else if (name.startsWith("@/")) name = path.join(web, name.slice(2));
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
