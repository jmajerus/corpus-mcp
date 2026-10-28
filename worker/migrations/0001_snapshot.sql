-- The public snapshot's schema (src/public/snapshot.ts SNAPSHOT_SCHEMA), for its replica in D1. A test keeps the two the same.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE books (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL, year INTEGER, publisher TEXT, language TEXT, isbn TEXT,
  format TEXT, citekeys TEXT NOT NULL, zotero_keys TEXT NOT NULL, sort TEXT NOT NULL
);
CREATE TABLE subjects (tag TEXT PRIMARY KEY, name TEXT NOT NULL, label TEXT NOT NULL, parent TEXT, books INTEGER NOT NULL);
CREATE TABLE book_subjects (book_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (book_id, tag));
CREATE INDEX book_subjects_tag ON book_subjects (tag);
CREATE TABLE shelves (id INTEGER PRIMARY KEY, name TEXT NOT NULL, books INTEGER NOT NULL);
CREATE TABLE book_shelves (book_id TEXT NOT NULL, shelf_id INTEGER NOT NULL, ord INTEGER, PRIMARY KEY (book_id, shelf_id));
CREATE INDEX book_shelves_shelf ON book_shelves (shelf_id, ord);
CREATE TABLE sites (url TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, fetched_at TEXT NOT NULL, keys TEXT NOT NULL);
CREATE TABLE links (book_id TEXT NOT NULL, site_url TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (book_id, site_url));
CREATE VIRTUAL TABLE books_fts USING fts5(book_id UNINDEXED, title, authors, subjects, tokenize = 'unicode61 remove_diacritics 2');
