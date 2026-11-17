import { expect, it } from "vitest";
import { pathSegment, queryValue } from "../src/urls.js";
import { BOOK_HTML } from "../src/web/book.js";

it("writes keys readably in links, encoding everything else", () => {
  expect(pathSegment("main:649")).toBe("main:649");
  expect(pathSegment("user@example.com")).toBe("user@example.com");
  expect(pathSegment("a/b c?d#e")).toBe("a%2Fb%20c%3Fd%23e");
  expect(queryValue("zotero:users/827407/TK8Z7VDH")).toBe("zotero:users/827407/TK8Z7VDH");
  expect(queryValue("Media Studies, Misc & More")).toBe("Media+Studies,+Misc+%26+More");
  // Both forms decode to the same key.
  for (const key of ["main:649", "a/b c?d#e", "x@y"]) expect(decodeURIComponent(pathSegment(key))).toBe(key);
  expect(new URLSearchParams(`q=${queryValue("Media Studies, a/b & c")}`).get("q")).toBe("Media Studies, a/b & c");
});

it("gives the admin pages the same helpers", () => {
  // The page script defines seg and qv with the same rules; run them as the browser would.
  const script = BOOK_HTML.match(/const readable = [^\n]+\nconst seg = [^\n]+\nconst qv = [^\n]+/)?.[0];
  expect(script).toBeTruthy();
  const { seg, qv } = new Function(`${script}; return { seg, qv };`)() as { seg: (v: string) => string; qv: (v: string) => string };
  for (const v of ["main:649", "a/b c?d#e", "x@y", "Media Studies, a/b"]) {
    expect(seg(v)).toBe(pathSegment(v));
    expect(qv(v)).toBe(queryValue(v));
  }
});
