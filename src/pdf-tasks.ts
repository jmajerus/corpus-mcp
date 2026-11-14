import fs from "node:fs";
import * as mupdf from "mupdf";
import { type ContentProfile, epubProfile, pdfProfile } from "./duplicate-contents.js";
import { type BookFormat, openBook } from "./extract.js";

/**
 * The MuPDF work the HTTP server does on request: a book file's content profile (the duplicates page) and a
 * rendered page (covers and render_page). MuPDF is synchronous and a damaged file can keep it busy for many
 * minutes, so the server runs these in a worker thread (src/pdf-runner.ts); the CLI and tests call them here.
 */
export type PdfTask =
  | { kind: "profile"; file: string; format: "EPUB" | "PDF" }
  | { kind: "render"; file: string; format: BookFormat; page: number; scale: number };

export interface RenderedPage { png: string; width: number; height: number }

export function runPdfTask(task: PdfTask): ContentProfile | RenderedPage {
  if (task.kind === "profile") return (task.format === "EPUB" ? epubProfile : pdfProfile)(fs.readFileSync(task.file));
  const doc = openBook(fs.readFileSync(task.file), task.format);
  try {
    const page = doc.loadPage(task.page - 1);
    try {
      const pixmap = page.toPixmap(mupdf.Matrix.scale(task.scale, task.scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        return { png: Buffer.from(pixmap.asPNG()).toString("base64"), width: pixmap.getWidth(), height: pixmap.getHeight() };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}
