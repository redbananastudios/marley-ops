// Minimal ambient types for pdfmake's Node printer (the package ships none we
// rely on, and @types/pdfmake targets the browser build). Only the surface the
// server printer (lib/pdf/server-pdf.ts) uses.
declare module "pdfmake" {
  interface PdfKitDocument {
    on(event: "data", cb: (chunk: Buffer) => void): void;
    on(event: "end", cb: () => void): void;
    on(event: "error", cb: (err: Error) => void): void;
    end(): void;
  }
  type FontFace = Buffer | string;
  interface FontDescriptor {
    normal?: FontFace;
    bold?: FontFace;
    italics?: FontFace;
    bolditalics?: FontFace;
    medium?: FontFace;
  }
  export default class PdfPrinter {
    constructor(fonts: Record<string, FontDescriptor>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createPdfKitDocument(docDefinition: any): PdfKitDocument;
  }
}
