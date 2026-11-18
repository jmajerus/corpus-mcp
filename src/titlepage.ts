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
 *   credits      a credits list: "Authors: A, B, C", or an "Authors" heading over one name a line (Packt's)
 *   title_page   a name on its own line on the title page, which also orders the others. Found only there,
 *                it counts when its line holds one name, since "Rahul Sharma Vesa Kaihlavirta" is two.
 *                Or the line right under the book's full title, on its title or copyright page, when every
 *                name in it reads as one ("Nasser Kehtarnavaz, Fatemeh Saki, and Arian Azarang").
 */

export type AuthorSource = "about" | "by" | "copyright" | "credits" | "title_page";

export interface AuthorCandidate {
  name: string;
  sources: AuthorSource[];
  /** 1-based page or location of the first sighting. */
  page: number;
  /** The printed line around it. */
  context: string;
}

export interface TitleCandidate { title: string; page: number }

export interface TitlePageScan {
  authors: AuthorCandidate[];
  title: TitleCandidate | null;
  /** The Calibre title the scan was made for: what's a title line, and whether it's a file name, depend on it. */
  for_title?: string;
}

/** Bump when scanTitlePage changes, so the indexer recomputes stored candidates (no re-extraction). */
export const TITLE_PAGE_SCAN_VERSION = 6;

export interface ScanPage { page_index: number; section_path: string | null; text: string }

/** Words that make a "name" a publisher, an organisation, a place, or a heading instead of a person. */
const NOT_A_PERSON = /\b(?:publish\w*|press|publications?|books?|media|inc|llc|ltd|limited|corp\w*|company|group|team|programmers|bookshelf|packt|manning|apress|o'?reilly|wiley|pearson|springer|elsevier|university|institute|association|department|society|foundation|council|edition|contents|chapter|preface|foreword|introduction|copyright|rights|reserved|about|contributors|reviewers?|editors?|authors?|birmingham|mumbai|london|new york|all|this|the|and|of|for|with|in|to)\b/i;

/** Name particles written in lower case. */
const PARTICLE = /^(?:de|da|di|del|della|der|den|van|von|la|le|du|dos|das|bin|ibn|al|el|y)$/;

/** More names than this found only on lines of their own, and the page isn't a title page. */
const MAX_LONE_NAMES = 6;

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

/**
 * Splits "A, B and C" (or "A, B, and C") into names, keeping a ", Jr." with its name and a ", Inc." with its company, so
 * "Alfred A. Knopf, Inc." stays whole and is seen to be a publisher.
 */
function splitNames(list: string): string[] {
  return list.split(/\s*(?:,\s*(?:and|&)\s+|,(?!\s*(?:jr|sr|ii|iii|iv|inc|llc|ltd|co|corp|plc|gmbh|ag|s\.?a|pty|limited|incorporated)\b)|;|\s+and\s+|\s*&\s*)\s*/i)
    .map((s) => s.trim()).filter(Boolean);
}

/** A biography's opening name: "Rahul Sharma is…", "Ivo Pinto, CISSP, is…". */
const LEAD = /^\s*((?:(?:Dr|Prof)\.?\s+)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:\p{Lu}[\p{L}'’.-]*|de|da|di|del|der|van|von|la|le|bin|al)){1,3})(?=,|\s+(?:is|has|was|works|holds|serves|leads|lives|joined|started|spent|currently|began|brings|teaches|did|earned|received|graduated|studied|completed)\b)/u;

const lineAt = (text: string, at: number, width = 90) => {
  const start = text.lastIndexOf("\n", at) + 1;
  const endAt = text.indexOf("\n", at);
  const line = text.slice(start, endAt < 0 ? text.length : endAt);
  return line.length > width ? `${line.slice(0, width).trim()}…` : line.trim();
};

/**
 * Letters and digits only, lower case, accents dropped: what a title squashed into a file name keeps, and
 * the key that tells two names apart. Letters of any script are kept ("Иван Иванов" isn't empty).
 */
export const squash = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * True for a Calibre title that's really a file name: an extension ("Book-layout1.indd"), a word
 * processor's caption ("Microsoft Word - LesterBook.doc"), a production code ("B40332_Building…"), or words
 * run together in lower case ("awscloudprojects", "masteringgo fourthedition").
 */
export function mangledTitle(title: string): boolean {
  return /^(?:unknown|untitled|no title)?$/i.test(title.trim()) || /^97[89]\d{10}[-_\s]/.test(title) || /\.(?:docx?|indd|pdf|epub|txt|rtf)$/i.test(title) || /^Microsoft Word - /i.test(title) || /^[A-Z]?\d{4,}_/.test(title)
    || title.split(/\s+/).some((w) => /^[a-z0-9+#-]{14,}$/.test(w))
    || (title === title.toLowerCase() && title.split(/\s+/).some((w) => /^[a-z0-9+#-]{10,}$/.test(w)));
}

/** How surely a page is the title page by its outline section: 2 for "Title Page", 1 for a cover or half title. */
function titlePageRank(p: ScanPage): number {
  const section = p.section_path ?? "";
  return /title page/i.test(section) ? 2 : /^cover$|cover page|half title/i.test(section) ? 1 : 0;
}

const isTitlePage = (p: ScanPage) => titlePageRank(p) > 0;

/**
 * The front-page line a squashed title was made from: the line whose squashed form and the title's start
 * the same way for longest. Either may run on past the other ("Mastering Go" for "masteringgo
 * fourthedition"), or they may part only near the end, where an edition is written differently ("Third
 * Edition" for "3rd edition"). Title pages first.
 */
function findTitle(pages: ScanPage[], calibreTitle: string, exact = false): TitleCandidate | null {
  const want = squash(calibreTitle.replace(/^(?:the|an?)\s+/i, "").replace(/^Microsoft Word - /i, "").replace(/\.\w{2,4}$/, "").replace(/^[A-Z]?\d{4,}_/, "").replace(/^97[89]\d{10}[-_\s]+/, ""));
  if (want.length < 10) return null;
  let best: TitleCandidate & { score: number; joined: boolean } | null = null;
  for (const p of [...pages.filter(isTitlePage), ...pages.filter((x) => !isTitlePage(x))]) {
    const lines = p.text.split("\n").map((l) => l.trim()).filter(Boolean);
    // A title printed over two or three lines ("Learning Elastic Stack 7.0" / "Second Edition") is read
    // whole: each line, then with the next ones joined on while the title goes on.
    const runs = lines.flatMap((line, i) => {
      const out = [{ text: line, joined: false }];
      for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
        const text = `${out.at(-1)!.text} ${lines[j]}`;
        if (!want.startsWith(squash(text))) break;
        out.push({ text, joined: true });
      }
      return out;
    });
    for (const { text: line, joined } of runs) {
      let got = squash(line), common = 0;
      if (got.length < 10 || line.length > 160) continue;
      for (const candidate of [got, squash(line.replace(/^(?:the|an?)\s+/i, ""))]) {
        let count = 0;
        while (count < candidate.length && count < want.length && candidate[count] === want[count]) count++;
        if (count > common) { common = count; got = candidate; }
      }
      if (common < 10) continue;
      const shorter = Math.min(got.length, want.length);
      if (common < shorter && (common < 15 || common < 0.6 * shorter)) continue;
      if (exact && (common !== want.length || got.length !== want.length)) continue;
      // On a tie, a title printed on one line (a copyright page's, punctuated) beats one joined from several.
      if (!best || common > best.score || (common === best.score && best.joined && !joined)) {
        best = { title: line.replace(/\s+/g, " ").trim(), page: p.page_index + 1, score: common, joined };
      }
    }
  }
  return best ? { title: best.title, page: best.page } : null;
}

/** Author candidates and, for a mangled Calibre title (or when asked), the printed title, from a book's front matter and "about" pages. */
export function scanTitlePage(pages: ScanPage[], calibreTitle: string, opts: { findTitle?: boolean } = {}): TitlePageScan {
  const found = new Map<string, AuthorCandidate>();
  const add = (raw: string, source: AuthorSource, page: ScanPage, at: number) => {
    const name = personName(raw);
    if (!name) return;
    const key = squash(name.replace(/,.*$/, ""));
    if (!key) return;
    const seen = found.get(key);
    if (seen) {
      if (!seen.sources.includes(source)) seen.sources.push(source);
      return;
    }
    found.set(key, { name, sources: [source], page: page.page_index + 1, context: lineAt(page.text, at) });
  };

  // "About the author(s)", up to the reviewers or editors that often follow. A section can run onto the
  // next pages: it carries on while they follow on directly, until a boundary or another section.
  const ABOUT = /\babout the authors?\b/i;
  const BOUNDARY = /\babout the (?:technical )?(?:reviewers?|editors?|translators?|illustrators?)\b|\babout the cover\b/i;
  // A PDF's text breaks at every printed line, so a line that opens with a name may be the middle of a
  // sentence ("Apache Spark, and NoSQL databases."): a name counts only where a paragraph starts, after a
  // blank line or a finished sentence. Without section names to follow, the section carries on for one
  // page at most, not into every page after it.
  const SENTENCE_END = /[.!?:]["”’)]?$/;
  type AboutRun = { page_index: number; section: string | null; last: string; carried: number };
  let about: AboutRun | null = null;
  for (const p of pages) {
    const text = p.text;
    const continues: boolean = !!about && p.page_index === about.page_index + 1
      && (p.section_path === about.section || ABOUT.test(p.section_path ?? ""))
      && (p.section_path !== null || about.carried < 1);
    const before: AboutRun | null = about;
    const carried: number = before ? before.carried : 0;
    const heading = text.match(ABOUT);
    const from = heading ? heading.index! + heading[0].length : continues || ABOUT.test(p.section_path ?? "") ? 0 : -1;
    about = null;
    if (from >= 0) {
      const rest = text.slice(from);
      const stop = rest.search(BOUNDARY);
      const section = stop < 0 ? rest : rest.slice(0, stop);
      const lines = section.split("\n");
      // The page's first line follows on from the last page's when the section carried over.
      let previous: string = !heading && continues && before ? before.last : "";
      let blank = !previous;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { blank = true; continue; }
        const lead = (blank || SENTENCE_END.test(previous)) && trimmed.match(LEAD);
        if (lead) add(lead[1], "about", p, from + section.indexOf(line));
        previous = trimmed;
        blank = false;
      }
      if (stop < 0) about = { page_index: p.page_index, section: p.section_path, last: previous, carried: continues && !heading ? carried + 1 : 0 };
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

  // Credits: "Authors: Jeganathan Swaminathan, Maya Posch, Jacek Galowicz" on a copyright page, or an
  // "Authors" heading over a name a line, up to the next role ("Reviewers"). A name printed with another
  // in brackets, "Yu-Wei, Chiu (David Chiu)", is read by whichever form is a name.
  const creditName = (raw: string) => {
    const bracket = /\(([^)]*)\)/.exec(raw)?.[1] ?? "";
    const bare = raw.replace(/\([^)]*\)/g, " ").trim();
    return personName(bare) ? bare : personName(bracket) ? bracket : null;
  };
  for (const p of pages.filter((x) => x.page_index < 20)) {
    const lines = p.text.split("\n").map((l) => l.trim());
    lines.forEach((line, i) => {
      const inline = /^(?:authors?|written by)\s*:\s*(.{3,200})$/i.exec(line);
      if (inline) for (const n of splitNames(inline[1])) add(n, "credits", p, p.text.indexOf(line));
      if (!/^authors?$/i.test(line)) return;
      for (const next of lines.slice(i + 1, i + 13).filter(Boolean)) {
        const name = creditName(next);
        if (!name) break;
        add(name, "credits", p, p.text.indexOf(next));
      }
    });
  }

  // A file-name title ("awscloudprojects") takes the printed line it starts like; a readable one asked
  // about ("Nodejs Complete Reference Guide") takes only one that reads the same but for case and
  // punctuation, never a longer line that merely starts the same way ("Mystic River, the PDF").
  const mangled = mangledTitle(calibreTitle);
  const title = (opts.findTitle ?? mangled) ? findTitle(pages, calibreTitle, !mangled) : null;
  const titles = [calibreTitle, title?.title ?? ""].map(squash).filter((t) => t.length >= 6);

  // The title page orders the names it shows, and adds a name printed alone on its own line.
  // The page marked "Title Page" in the outline, before a cover, which may carry only the title.
  let titlePage = pages.find((p) => titlePageRank(p) === 2 && p.text.trim()) ?? pages.find((p) => titlePageRank(p) === 1 && p.text.trim())
    ?? pages.find((p) => p.text.split("\n").filter((l) => l.trim()).length >= 2);
  // Pandoc may put the title and each author in separate blocks. Use the initial title
  // run, stopping before copyright/front-matter boundaries, rather than a later multiline code block.
  const titleStart = pages.findIndex(p => p.page_index < 20 && titles.some(t => squash(p.text).includes(t)));
  if (titleStart >= 0 && (!titlePage || (titlePageRank(titlePage) === 0 && titlePage.page_index > pages[titleStart].page_index + 10))) titlePage = pages[titleStart];
  if (titlePage && titlePage.text.split("\n").filter(l => l.trim()).length <= 2 && !/copyright|all rights reserved|table of contents|about the author/i.test(titlePage.text)) {
    const start = pages.indexOf(titlePage), parts = [titlePage.text];
    let size = titlePage.text.length;
    for (let i = start + 1; i < pages.length && i <= start + 20; i++) {
      const p = pages[i];
      if (p.page_index !== pages[i - 1].page_index + 1 || p.section_path !== titlePage.section_path
        || /copyright|all rights reserved|table of contents|about the author/i.test(p.text) || size + p.text.length > 8000) break;
      parts.push(p.text); size += p.text.length;
    }
    titlePage = { ...titlePage, text: parts.join("\n\n") };
  }
  const order: string[] = [];
  const lone: string[] = [];
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
        const source = pages.find(p => p.page_index >= titlePage!.page_index && p.text.split("\n").includes(line)) ?? titlePage;
        add(line, "title_page", source, source.text.indexOf(line));
        if (found.size > before) { order.push([...found.keys()].at(-1)!); lone.push([...found.keys()].at(-1)!); }
      }
    }
  }
  // A title page prints a few names. A "title page" giving many names on lines of their own is really a
  // chapter or a contents page, and its short lines are headings ("Key Points", "Covalent Bonds").
  if (lone.length > MAX_LONE_NAMES) {
    for (const k of lone) { found.delete(k); order.splice(order.indexOf(k), 1); }
  }
  // The line under the book's full title: on a title page that follows a series' list of its other books
  // (Morgan & Claypool's), or on a copyright page that repeats title and authors. Every name in it must
  // read as one, so an affiliation, or a name that lost letters to a ligature ("omas F. Schubert"), keeps
  // the whole line out rather than giving half the authors. One name alone holds at most three words
  // (as above), a "by" line is the by-line's, and a page the outline marks as the title page is the only
  // one read when there is one.
  const fullTitles = titles.filter((t) => t.length >= 10);
  const marked = pages.filter((x) => titlePageRank(x) === 2);
  for (const p of marked.length ? marked : pages.filter((x) => x.page_index < 20)) {
    const lines = p.text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let k = 0; k + 1 < lines.length; k++) {
      let run = "";
      let under = false;
      for (let i = k; i >= Math.max(0, k - 5) && !under; i--) {
        run = squash(lines[i]) + run;
        under = fullTitles.includes(run);
      }
      if (!under) continue;
      const next = lines[k + 1];
      if (/^(?:written\s+|edited\s+)?by\b/i.test(next)) continue;
      const parts = splitNames(next);
      if (!parts.length || !parts.every((n) => personName(n))) continue;
      if (parts.length === 1 && next.split(/\s+/).length > 3) continue;
      for (const n of parts) {
        add(n, "title_page", p, p.text.indexOf(lines[k + 1]));
        const key = squash(personName(n)!.replace(/,.*$/, ""));
        if (!found.get(key)!.sources.includes("title_page")) found.get(key)!.sources.push("title_page");
        if (!order.includes(key)) order.push(key);
      }
    }
  }
  const authors = [...order.map((k) => found.get(k)!), ...[...found.entries()].filter(([k]) => !order.includes(k)).map(([, v]) => v)];
  return { authors, title };
}
