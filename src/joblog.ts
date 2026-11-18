/**
 * Keeps the PDF and EPUB readers' warnings out of a job's log. Calibre's poppler tools, mupdf in the
 * indexer, and Calibre's cover renderer write to stderr about defects in the files they read (dead
 * links, unknown font weights, fonts named in CSS but not shipped). None of them stops a book from
 * being added or indexed, so the log counts them in one closing line instead of listing them.
 */

const NOISE: [source: string, pattern: RegExp][] = [
  // poppler (pdfinfo, pdftoppm), run by Calibre when it adds a PDF.
  ["PDF", /^Syntax (?:Warning|Error)(?: \(\d+\))?: /],
  // mupdf, while the indexer reads a PDF or EPUB.
  ["PDF and EPUB", /^(?:warning|format error|error: cannot load|warning: \.\.\. repeated)/],
];

/** Calibre's message when it can't draw a cover from an EPUB's first page, followed by a traceback. */
const RENDER_FAILED = /^Failed to render \S+ with errors:$/;

export class JobLogFilter {
  private counts = new Map<string, number>();
  private inTraceback = false;
  private afterTraceback = false;

  /** The line as the log should show it, or null to leave it out. */
  line(text: string): string | null {
    if (this.afterTraceback) {
      this.afterTraceback = false;
      if (text === "") return null;
    }
    if (this.inTraceback) {
      if (/^(?:Traceback |\s)/.test(text)) return null;
      this.inTraceback = false;
      if (/^\w+(?:\.\w+)*(?:Error|Exception)\b/.test(text)) {
        this.afterTraceback = true;
        return null;
      }
    }
    if (RENDER_FAILED.test(text)) {
      this.inTraceback = true;
      return "Calibre couldn't draw a cover from an EPUB's first page, so that book may be added without a cover.";
    }
    const source = NOISE.find(([, pattern]) => pattern.test(text))?.[0];
    if (!source) return text;
    this.counts.set(source, (this.counts.get(source) ?? 0) + 1);
    return null;
  }

  /** One closing line counting the warnings left out, or null if there were none. */
  summary(): string | null {
    if (!this.counts.size) return null;
    const parts = [...this.counts].map(([source, n]) => `${n} from the ${source} readers`);
    return `Hid ${parts.join(" and ")}: warnings about defects in the files (dead links, missing fonts) that don't affect adding or indexing them.`;
  }
}
