export type InvoicePrintDocument = { html: string; title: string };

/** Export only the invoice, including local fonts/images, for the native printer. */
export async function createInvoicePrintDocument(
  sheet: HTMLElement,
  title: string,
): Promise<InvoicePrintDocument> {
  const styles: { css: string; base: string }[] = [];
  function collect(rules: CSSRuleList, base: string, printing = false) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule && rule.styleSheet) {
        collect(rule.styleSheet.cssRules, rule.href, printing);
      } else if (rule instanceof CSSMediaRule) {
        if (rule.conditionText.includes("print"))
          collect(rule.cssRules, base, true);
      } else if (
        (rule instanceof CSSFontFaceRule &&
          rule.style
            .getPropertyValue("font-family")
            .includes("Noto Sans Bengali")) ||
        (rule instanceof CSSPageRule &&
          rule.selectorText === "sales-invoice") ||
        (printing &&
          rule instanceof CSSStyleRule &&
          rule.selectorText.includes("invoice"))
      ) {
        styles.push({ css: rule.cssText, base });
      }
    }
  }
  for (const stylesheet of Array.from(document.styleSheets)) {
    // App styles are bundled locally. An unrelated cross-origin extension sheet
    // may deny CSSOM access and is not part of the invoice.
    try {
      collect(stylesheet.cssRules, stylesheet.href || document.baseURI);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "SecurityError"))
        throw error;
    }
  }
  if (!styles.some(({ css }) => css.includes(".invoice-shop-header"))) {
    throw new Error("Invoice print styles are not ready. Please try again.");
  }
  const assets = new Map<string, Promise<string>>();
  function inlineAsset(url: string) {
    let asset = assets.get(url);
    if (!asset) {
      asset = (async () => {
        const response = await fetch(url);
        if (!response.ok && response.status !== 0)
          throw new Error("Unable to load the invoice font.");
        const blob = await response.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () =>
            reject(new Error("Unable to read the invoice font."));
          reader.readAsDataURL(blob);
        });
      })();
      assets.set(url, asset);
    }
    return asset;
  }
  const css = await Promise.all(
    styles.map(async ({ css, base }) => {
      const urls = Array.from(
        css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g),
      );
      for (const match of urls) {
        if (match[1].startsWith("data:")) continue;
        const data = await inlineAsset(new URL(match[1], base).href);
        css = css.replace(match[0], `url("${data}")`);
      }
      return css;
    }),
  );
  const clone = sheet.cloneNode(true) as HTMLElement;
  await Promise.all(
    Array.from(sheet.querySelectorAll("img")).map(async (image, index) => {
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(image.naturalWidth, 1024);
      canvas.height = Math.round(
        (canvas.width * image.naturalHeight) / image.naturalWidth,
      );
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to prepare the invoice logo.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const target = clone.querySelectorAll("img")[index];
      target.removeAttribute("srcset");
      target.removeAttribute("sizes");
      target.src = canvas.toDataURL("image/png");
    }),
  );
  const output = document.implementation.createHTMLDocument(title);
  output.documentElement.lang = "bn";
  const charset = output.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  output.head.prepend(charset);
  const style = output.createElement("style");
  style.textContent = `html,body{margin:0;padding:0;background:#fff} ${css.join("\n")}`;
  output.head.append(style);
  output.body.append(output.importNode(clone, true));
  return { title, html: "<!doctype html>" + output.documentElement.outerHTML };
}
