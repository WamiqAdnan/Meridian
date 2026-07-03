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
  function pdfParse(dataBuffer: Buffer | Uint8Array): Promise<PDFParseResult>;
  export default pdfParse;
}
