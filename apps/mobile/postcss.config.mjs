import { fileURLToPath } from "node:url";
export default {
  plugins: {
    "@tailwindcss/postcss": {
      base: fileURLToPath(new URL("../web", import.meta.url)),
    },
    "./postcss-inline-assets.cjs": {},
  },
};
