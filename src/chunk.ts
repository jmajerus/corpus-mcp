/** Target passage size. Passages never cross a page, so a search hit always has one locator. */
const TARGET_WORDS = 220;
const MAX_WORDS = 320;

/** Groups a page's paragraphs into passages of roughly TARGET_WORDS, splitting only overlong paragraphs. */
export function chunkPage(paragraphs: string[]): string[] {
  const passages: string[] = [];
  let current: string[] = [];
  let words = 0;

  const flush = () => {
    if (current.length) passages.push(current.join("\n\n"));
    current = [];
    words = 0;
  };

  for (const paragraph of paragraphs) {
    const tokens = paragraph.split(/\s+/).filter(Boolean);
    if (tokens.length > MAX_WORDS) {
      flush();
      for (let i = 0; i < tokens.length; i += TARGET_WORDS) {
        passages.push(tokens.slice(i, i + TARGET_WORDS).join(" "));
      }
      continue;
    }
    if (words + tokens.length > MAX_WORDS) flush();
    current.push(paragraph);
    words += tokens.length;
    if (words >= TARGET_WORDS) flush();
  }
  flush();
  return passages;
}
