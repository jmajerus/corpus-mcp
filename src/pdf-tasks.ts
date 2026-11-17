import fs from "node:fs";
import * as mupdf from "mupdf";
import { type ContentProfile, epubProfile, pdfProfile } from "./duplicate-contents.js";
import { type BookFormat, openBook } from "./extract.js";

/**
 * The MuPDF work the HTTP server does on request: a book file's content profile (the duplicates page), a
 * rendered page (covers and render_page), and a cover thumbnail for the public catalogue. MuPDF is synchronous and a damaged file can keep it busy for many
 * minutes, so the server runs these in a worker thread (src/pdf-runner.ts); the CLI and tests call them here.
 */
export type PdfTask =
  | { kind: "profile"; file: string; format: "EPUB" | "PDF" }
  | { kind: "render"; file: string; format: BookFormat; page: number; scale: number }
  | { kind: "thumb"; file: string; format: BookFormat | "image"; width: number };

export interface RenderedPage { png: string; width: number; height: number }
/** A JPEG, base64-encoded. */
export interface Thumbnail { jpeg: string; width: number; height: number }

export function runPdfTask(task: PdfTask): ContentProfile | RenderedPage | Thumbnail {
  if (task.kind === "profile") return (task.format === "EPUB" ? epubProfile : pdfProfile)(fs.readFileSync(task.file));
  if (task.kind === "thumb") return thumbnail(task.file, task.format, task.width);
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

/**
 * A cover `width` pixels wide, as a JPEG: from an image (Calibre's cover.jpg), opened as a one-page
 * document, or from a book's first page.
 */
function thumbnail(file: string, format: BookFormat | "image", width: number): Thumbnail {
  const data = fs.readFileSync(file);
  const doc = format === "image" ? mupdf.Document.openDocument(data, "image/jpeg") : openBook(data, format);
  try {
    const page = doc.loadPage(0);
    try {
      const [x0, , x1] = page.getBounds();
      if (!(x1 > x0)) throw new Error("the cover has no width");
      const scale = width / (x1 - x0);
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        return { jpeg: Buffer.from(pixmap.asJPEG(80)).toString("base64"), width: pixmap.getWidth(), height: pixmap.getHeight() };
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
