import { describe, expect, it } from "vitest";
import { JobLogFilter } from "../src/joblog.js";

const run = (text: string) => {
  const filter = new JobLogFilter();
  const shown = text.split("\n").map(l => filter.line(l)).filter(l => l !== null);
  return { shown, summary: filter.summary() };
};

describe("job log filter", () => {
  it("hides the PDF and EPUB readers' warnings and counts them", () => {
    const { shown, summary } = run([
      "Syntax Warning: Invalid Font Weight",
      "Backed up metadata.db to /mnt/x",
      "Syntax Warning: Bad annotation destination",
      "indexed main:1543 Cardiovascular Pathophysiology (pdf, 79 pages)",
      "warning: ... repeated 17 times...",
      "warning: JPX numcomps (1) doesn't match color_space (3)",
      "format error: cannot locate font 'res:///Data/fonts/LiberationNarrow-Regular.otf' specified by css",
      "warning: cannot load font-face: res:///Data/fonts/LiberationNarrow-Regular.otf",
    ].join("\n"));
    expect(shown).toEqual(["Backed up metadata.db to /mnt/x", "indexed main:1543 Cardiovascular Pathophysiology (pdf, 79 pages)"]);
    expect(summary).toMatch(/^Hid 2 from the PDF readers and 4 from the PDF and EPUB readers/);
  });

  it("replaces Calibre's cover-render traceback with one line", () => {
    const { shown, summary } = run([
      "Failed to render /tmp/calibre-wjk1_ixr/nkq0al3y_epub_meta/index.html with errors:",
      "Traceback (most recent call last):",
      '  File "/usr/lib/calibre/calibre/utils/filenames.py", line 528, in atomic_rename',
      "    os.rename(oldpath, newpath)",
      "    ~~~~~~~~~^^^^^^^^^^^^^^^^^^",
      "FileNotFoundError: [Errno 2] No such file or directory: 'page-images-1.jpg' -> 'rendered.jpeg'",
      "",
      "Refreshing the index…",
    ].join("\n"));
    expect(shown).toEqual([expect.stringMatching(/^Calibre couldn't draw a cover/), "Refreshing the index…"]);
    expect(summary).toBeNull();
  });

  it("keeps other errors and tracebacks", () => {
    const lines = ["Traceback (most recent call last):", '  File "x.py", line 1', "ValueError: bad", "Upload failed."];
    expect(run(lines.join("\n")).shown).toEqual(lines);
  });
});
