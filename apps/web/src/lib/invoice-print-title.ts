/** Chrome uses the outer tab title when printing an embedded mobile preview. */
export function setInvoicePrintTitle(title: string): () => void {
  const documents: { document: Document; previousTitle: string }[] = [];
  let current: Window = window;
  while (true) {
    try {
      const document = current.document;
      documents.push({ document, previousTitle: document.title });
      document.title = title;
      if (current === current.parent) break;
      current = current.parent;
    } catch {
      // An embedding page on another origin cannot be changed by this app.
      break;
    }
  }
  return () => {
    for (const { document, previousTitle } of documents) {
      if (document.title === title) document.title = previousTitle;
    }
  };
}
