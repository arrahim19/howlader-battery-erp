import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const compiledPrinter = build({
  entryPoints: ["apps/mobile/src/lib/print-invoice.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  plugins: [
    {
      name: "native-print-sandbox",
      setup(builder) {
        builder.onResolve(
          { filter: /^(expo-print|expo-file-system|expo-crypto)$/ },
          (args) => ({ path: args.path, namespace: "native-mock" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "native-mock" }, (args) => ({
          contents: `module.exports = globalThis.__nativeMocks[${JSON.stringify(args.path)}];`,
          loader: "js",
        }));
      },
    },
  ],
});

async function printerForExpoGo(base64?: string) {
  const printed: string[] = [];
  const written: { uri: string; content: string; encoding: string }[] = [];
  class Directory {
    uri: string;
    constructor(...parts: (string | Directory)[]) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri))
        .join("/");
    }
    async create() {}
  }
  class File {
    uri: string;
    constructor(...parts: (string | Directory)[]) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri))
        .join("/");
    }
    async create() {}
    async move() {
      throw new Error(
        "Missing READ permission for Expo Print's unscoped cache",
      );
    }
    async write(content: string, options: { encoding: string }) {
      assert.ok(
        this.uri.startsWith("file:///experience/cache/printed-invoices/"),
      );
      written.push({ uri: this.uri, content, encoding: options.encoding });
    }
  }
  const module = {
    exports: {} as {
      printInvoice: (document: {
        html: string;
        title: string;
      }) => Promise<void>;
    },
  };
  runInNewContext((await compiledPrinter).outputFiles[0].text, {
    module,
    __nativeMocks: {
      "expo-print": {
        printToFileAsync: async (options: { base64?: boolean }) => {
          assert.equal(options.base64, true);
          return {
            uri: "file:///expo-go/unscoped/Print/generated.pdf",
            base64,
            numberOfPages: 1,
          };
        },
        printAsync: async ({ uri }: { uri: string }) => {
          printed.push(uri);
        },
      },
      "expo-file-system": {
        Directory,
        File,
        Paths: { cache: new Directory("file:///experience/cache") },
      },
      "expo-crypto": { randomUUID: () => "print-request-1" },
    },
  });
  return { print: module.exports.printInvoice, printed, written };
}

test("Expo Go prints a named PDF without reading Print's inaccessible cache URI", async () => {
  const pdf = Buffer.from("%PDF-1.7\nSample invoice").toString("base64");
  const printer = await printerForExpoGo(pdf);
  await printer.print({
    html: "<html><body>Invoice</body></html>",
    title: "হাওলাদার - HB-0022",
  });
  assert.equal(printer.written.length, 1);
  assert.equal(printer.written[0].content, pdf);
  assert.equal(printer.written[0].encoding, "base64");
  assert.equal(printer.printed[0], printer.written[0].uri);
  assert.ok(printer.printed[0].endsWith("হাওলাদার - HB-0022.pdf"));
});

test("a missing rendered PDF never opens the printer with an empty file", async () => {
  const printer = await printerForExpoGo();
  await assert.rejects(
    printer.print({ html: "<html>Invoice</html>", title: "HB-0022" }),
    /PDF could not be read/,
  );
  assert.equal(printer.written.length, 0);
  assert.equal(printer.printed.length, 0);
});
