/**
 * Reading a book's authors and title from its own pages, for books whose Calibre metadata has no author,
 * several people in one author record, or a title that's really a file name ("awscloudprojects",
 * "Book-layout1.indd"). What's found are candidates for a person to confirm and fix in Calibre: unlike a
 * printed year, a wrong author does more harm than a missing one, so nothing here goes into a citation.
 *
 * Authors come from, most reliable first:
 *   about        an "About the author(s)" section: each paragraph that opens with a name ("Rahul Sharma is…")
 *   by           a "by …" line ("BY WILLIAM STRUNK, Jr.")
 *   copyright    the copyright holder ("Copyright 2016 by Kelly Oliver", "© Kit Eason 2022"), not a publisher
 *   title_page   a name on its own line on the title page, which also orders the others. Found only there,
 *                it counts when its line holds one name, since "Rahul Sharma Vesa Kaihlavirta" is two.
 */

export type AuthorSource = "about" | "by" | "copyright" | "title_page";

export interface AuthorCandidate {
  name: string;
  sources: AuthorSource[];
  /** 1-based page or location of the first sighting. */
  page: number;
  /** The printed line around it. */
  context: string;
}

export interface TitleCandidate { title: string; page: number }

export interface TitlePageScan { authors: AuthorCandidate[]; title: TitleCandidate | null }

/** Bump when scanTitlePage changes, so the indexer recomputes stored candidates (no re-extraction). */
export const TITLE_PAGE_SCAN_VERSION = 1;

export interface ScanPage { page_index: number; section_path: string | null; text: string }

/** Words that make a "name" a publisher, an organisation, a place, or a heading instead of a person. */
const NOT_A_PERSON = /\b(?:publish\w*|press|publications?|books?|media|inc|llc|ltd|limited|corp\w*|company|group|team|programmers|bookshelf|packt|manning|apress|o'?reilly|wiley|pearson|springer|elsevier|university|institute|association|department|society|foundation|council|edition|contents|chapter|preface|foreword|introduction|copyright|rights|reserved|about|contributors|reviewers?|editors?|authors?|birmingham|mumbai|london|new york|all|this|the|and|of|for|with|in|to)\b/i;

/** Name particles written in lower case. */
const PARTICLE = /^(?:de|da|di|del|della|der|den|van|von|la|le|du|dos|das|bin|ibn|al|el|y)$/;

const SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;

function titleCase(word: string): string {
  return word.replace(/(^|[-'’])(\p{L})(\p{L}*)/gu, (_, sep: string, first: string, rest: string) => sep + first.toUpperCase() + rest.toLowerCase());
}

/** A person's name as printed, tidied ("WILLIAM STRUNK, JR." → "William Strunk, Jr."), or null when it isn't one. */
export function personName(raw: string): string | null {
  let text = raw.replace(/\s+/g, " ").replace(/^(?:dr|prof|professor|mr|mrs|ms)\.?\s+/i, "").replace(/[\s,;:.]+$/, "").trim();
  // A trailing suffix stays with the name; degrees ("M.D.", "PhD") are dropped.
  let suffix = "";
  const tail = text.match(/,\s*(jr|sr|ii|iii|iv)\.?$/i);
  if (tail) {
    suffix = `, ${tail[1].length <= 2 ? `${titleCase(tail[1])}.` : tail[1].toUpperCase()}`;
    text = text.slice(0, tail.index).trim();
  }
  text = text.replace(/,\s*(?:m\.?d\.?|ph\.?d\.?|m\.?b\.?a\.?|j\.?d\.?|d\.?phil\.?|m\.?sc\.?)\b.*$/i, "").trim();
  if (!text || /\d|@|https?:|www\.|[()[\]{}|]/.test(text) || NOT_A_PERSON.test(text)) return null;
  const words = text.split(" ");
  if (words.length < 2 || words.length > 4) return null;
  let capitals = 0;
  for (const w of words) {
    if (PARTICLE.test(w) || SUFFIX.test(w)) continue;
    if (!/^(?:\p{Lu}\.?(?:-?\p{Lu}\.)*|\p{Lu}[\p{L}'’.-]*)$/u.test(w)) return null;
    capitals++;
  }
  if (capitals < 2) return null;
  const allCaps = text === text.toUpperCase();
  const tidy = words.map((w) => (allCaps && w.length > 2 && !/\./.test(w) ? titleCase(w) : w)).join(" ");
  return tidy + suffix;
}

/** Splits "A, B and C" into names, keeping a ", Jr." with its name. */
function splitNames(list: string): string[] {
  return list.split(/\s*(?:,(?!\s*(?:jr|sr|ii|iii|iv)\b)|;|\s+and\s+|\s*&\s*)\s*/i).map((s) => s.trim()).filter(Boolean);
}

const lineAt = (text: string, at: number, width = 90) => {
  const start = text.lastIndexOf("\n", at) + 1;
  const endAt = text.indexOf("\n", at);
  const line = text.slice(start, endAt < 0 ? text.length : endAt);
  return line.length > width ? `${line.slice(0, width).trim()}…` : line.trim();
};

/** Letters and digits only, lower case: what a title squashed into a file name keeps. */
export const squash = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/**
 * True for a Calibre title that's really a file name: an extension ("Book-layout1.indd"), a word
 * processor's caption ("Microsoft Word - LesterBook.doc"), a production code ("B40332_Building…"), or words
 * run together in lower case ("awscloudprojects", "masteringgo fourthedition").
 */
export function mangledTitle(title: string): boolean {
  return /\.(?:docx?|indd|pdf|epub|txt|rtf)$/i.test(title) || /^Microsoft Word - /i.test(title) || /^[A-Z]?\d{4,}_/.test(title)
    || title.split(/\s+/).some((w) => /^[a-z0-9+#-]{14,}$/.test(w))
    || (title === title.toLowerCase() && title.split(/\s+/).some((w) => /^[a-z0-9+#-]{10,}$/.test(w)));
}

function isTitlePage(p: ScanPage): boolean {
  return /title page|^cover$|half title/i.test(p.section_path ?? "");
}

/**
 * The front-page line a squashed title was made from: the line whose squashed form and the title's start
 * the same way for longest. Either may run on past the other ("Mastering Go" for "masteringgo
 * fourthedition"), or they may part only near the end, where an edition is written differently ("Third
 * Edition" for "3rd edition"). Title pages first.
 */
function findTitle(pages: ScanPage[], calibreTitle: string): TitleCandidate | null {
  const want = squash(calibreTitle.replace(/^Microsoft Word - /i, "").replace(/\.\w{2,4}$/, "").replace(/^[A-Z]?\d{4,}_/, ""));
  if (want.length < 10) return null;
  let best: TitleCandidate & { score: number } | null = null;
  for (const p of [...pages.filter(isTitlePage), ...pages.filter((x) => !isTitlePage(x))]) {
    for (const line of p.text.split("\n")) {
      const got = squash(line);
      if (got.length < 10 || line.length > 160) continue;
      let common = 0;
      while (common < got.length && common < want.length && got[common] === want[common]) common++;
      if (common < 10) continue;
      const shorter = Math.min(got.length, want.length);
      if (common < shorter && (common < 15 || common < 0.6 * shorter)) continue;
      if (!best || common > best.score) best = { title: line.replace(/\s+/g, " ").trim(), page: p.page_index + 1, score: common };
    }
  }
  return best ? { title: best.title, page: best.page } : null;
}

/** Author candidates and, for a mangled Calibre title, the printed title, from a book's front matter and "about" pages. */
export function scanTitlePage(pages: ScanPage[], calibreTitle: string): TitlePageScan {
  const found = new Map<string, AuthorCandidate>();
  const add = (raw: string, source: AuthorSource, page: ScanPage, at: number) => {
    const name = personName(raw);
    if (!name) return;
    const key = squash(name.replace(/,.*$/, ""));
    const seen = found.get(key);
    if (seen) {
      if (!seen.sources.includes(source)) seen.sources.push(source);
      return;
    }
    found.set(key, { name, sources: [source], page: page.page_index + 1, context: lineAt(page.text, at) });
  };

  for (const p of pages) {
    const text = p.text;
    // "About the author(s)", up to the reviewers or editors that often follow.
    for (const m of text.matchAll(/\babout the authors?\b/gi)) {
      const rest = text.slice(m.index! + m[0].length);
      const end = rest.search(/\babout the (?:technical )?(?:reviewers?|editors?|translators?|illustrators?)\b|\babout the cover\b/i);
      const section = end < 0 ? rest.slice(0, 6000) : rest.slice(0, end);
      for (const para of section.split(/\n+/)) {
        const lead = para.match(/^\s*((?:(?:Dr|Prof)\.?\s+)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:\p{Lu}[\p{L}'’.-]*|de|da|di|del|der|van|von|la|le|bin|al)){1,3})(?=,|\s+(?:is|has|was|works|holds|serves|leads|lives|joined|started|spent|currently|began|brings|teaches)\b)/u);
        if (lead) add(lead[1], "about", p, m.index! + m[0].length + section.indexOf(para));
      }
    }
    for (const line of text.split("\n")) {
      const at = text.indexOf(line);
      const by = line.match(/^\s*(?:written\s+|edited\s+)?by\s+(.{3,100})$/i);
      if (by) for (const n of splitNames(by[1])) add(n, "by", p, at);
      // A copyright holder, unless the line is about a part of the book (a translation, notes, an introduction).
      const c = line.match(/(?:\bcopyright\b|©)/i);
      if (c && !/\b(?:translation|notes|introduction|foreword|preface|afterword|illustrations?|cover|photograph\w*|design)\b[^©]*$/i.test(line.slice(0, c.index))) {
        const holder = line.slice(c.index! + c[0].length)
          .replace(/all rights reserved.*$/i, "").replace(/\bthis (?:book|work|edition)\b.*$/i, "")
          .replace(/(?:©|\(c\)|copyright)/gi, " ").replace(/\b(?:1[4-9]\d\d|20\d\d)\b(?:\s*[,–-]\s*\d{2,4})*/g, " ")
          .replace(/^[\s,.:]*(?:by\s+)?/i, "").replace(/\s+by\s+/i, " ").replace(/[\s,.]+$/, "");
        if (holder) for (const n of splitNames(holder)) add(n, "copyright", p, at);
      }
    }
  }

  const title = mangledTitle(calibreTitle) ? findTitle(pages, calibreTitle) : null;
  const titles = [calibreTitle, title?.title ?? ""].map(squash).filter((t) => t.length >= 6);

  // The title page orders the names it shows, and adds a name printed alone on its own line.
  const titlePage = pages.find((p) => isTitlePage(p) && p.text.trim()) ?? pages.find((p) => p.text.split("\n").filter((l) => l.trim()).length >= 2);
  const order: string[] = [];
  if (titlePage) {
    for (const line of titlePage.text.split("\n")) {
      const keys = [...found.keys()].filter((k) => squash(line).includes(k)).sort((a, b) => squash(line).indexOf(a) - squash(line).indexOf(b));
      for (const k of keys) {
        if (!found.get(k)!.sources.includes("title_page")) found.get(k)!.sources.push("title_page");
        if (!order.includes(k)) order.push(k);
      }
      // A line that's the book's title, or part of it, is no name ("AWS Cloud Projects").
      const part = squash(line);
      const titled = titles.some((t) => t.includes(part) || part.includes(t));
      if (!keys.length && !titled && line.trim().split(/\s+/).length <= 3) {
        const before = found.size;
        add(line, "title_page", titlePage, titlePage.text.indexOf(line));
        if (found.size > before) order.push([...found.keys()].at(-1)!);
      }
    }
  }
  const authors = [...order.map((k) => found.get(k)!), ...[...found.entries()].filter(([k]) => !order.includes(k)).map(([, v]) => v)];
  return { authors, title };
}
