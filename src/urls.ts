/**
 * Keys written readably in links people see: /admin/books/main:649 rather than main%3A649. A colon and an
 * @ are legal as they are in a path segment (the path starts with "/") and in a query; a query also keeps
 * "/" and "," and writes a space as "+". Everything else is encoded. Both forms keep working on the way
 * in, since requests are decoded with decodeURIComponent and URLSearchParams. The admin pages' script
 * has the same two helpers (seg, qv in src/web/layout.ts). API calls to other services keep plain
 * encodeURIComponent; only links need this. The same rules as holdings-mcp's src/urls.ts.
 */
const readable = (encoded: string) => encoded.replace(/%(3A|40)/gi, (m) => decodeURIComponent(m));

/** One path segment: /admin/books/main:649, /books/main:186. */
export const pathSegment = (value: string): string => readable(encodeURIComponent(value));

/** One query value: ?work=zotero:users/1/ABCD, ?shelf=Media+Studies. */
export const queryValue = (value: string): string =>
  readable(encodeURIComponent(value)).replace(/%20/g, "+").replace(/%(2F|2C)/gi, (m) => decodeURIComponent(m));
