// pdf-parse ships no types for its internal entrypoint (which we import directly
// to avoid the debug harness in the package's index.js).
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PDFParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }
  interface PDFParseOptions {
    // Custom per-page renderer; receives a pdfjs page proxy.
    pagerender?: (pageData: {
      getTextContent: (opts: {
        normalizeWhitespace: boolean;
        disableCombineTextItems: boolean;
      }) => Promise<{ items: { str: string; transform: number[] }[] }>;
    }) => Promise<string>;
    max?: number;
  }
  function pdfParse(dataBuffer: Buffer | Uint8Array, options?: PDFParseOptions): Promise<PDFParseResult>;
  export default pdfParse;
}
