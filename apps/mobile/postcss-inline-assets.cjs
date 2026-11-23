/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS plugin loaded by the PostCSS pipeline. */
const fs = require("node:fs");
const path = require("node:path");
// Metro doesn't rewrite relative CSS font URLs. Bundle the existing web fonts
// as data URLs, so native DOM exports also load them without a server.
module.exports = () => ({
  postcssPlugin: "howlader-inline-fonts",
  AtRule(rule) {
    if (rule.name !== "font-face") return;
    const family = rule.nodes.find(
      (node) => node.prop === "font-family",
    )?.value;
    const source = rule.nodes.find((node) => node.prop === "src")?.value ?? "";
    // Package the scripts the interface uses; Android's system fonts remain
    // available for other scripts. Keep Latin extensions for names/addresses.
    if (
      family?.includes("Inter") &&
      /inter-(cyrillic|greek|vietnamese)/.test(source)
    )
      rule.remove();
  },
  Declaration(decl) {
    if (!decl.source?.input.file) return;
    decl.value = decl.value.replace(
      /url\((['"]?)(\.\/?[^)'"\s]+\.woff2)\1\)/g,
      (match, quote, name) => {
        const file = path.resolve(path.dirname(decl.source.input.file), name);
        return `url("data:font/woff2;base64,${fs.readFileSync(file).toString("base64")}")`;
      },
    );
  },
});
module.exports.postcss = true;
