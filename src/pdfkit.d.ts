declare module 'pdfkit' {
  import { Readable } from 'stream';

  interface PDFDocumentOptions {
    size?: string | [number, number];
    margins?: { top: number; bottom: number; left: number; right: number };
    info?: { Title?: string; Author?: string; Subject?: string };
  }

  class PDFDocument extends Readable {
    constructor(options?: PDFDocumentOptions);
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    fontSize(size: number): this;
    fillColor(color: string): this;
    text(text: string, xOrOptions?: number | any, y?: number, options?: any): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    strokeColor(color: string): this;
    lineWidth(width: number): this;
    stroke(): this;
    moveDown(lines?: number): this;
    rect(x: number, y: number, w: number, h: number): this;
    fill(color?: string): this;
    font(name: string): this;
    end(): void;
    y: number;
  }

  export default PDFDocument;
}