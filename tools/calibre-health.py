#!/usr/bin/env python3
"""Read-only health check of a Calibre library: does metadata.db agree with the folders on disk?

    python3 calibre-health.py <library> [--app-db app.db] [--backups <dir>]

Runs on the Calibre-Web host through corpus-source.sh's "health" command (corpus-mcp's Library
health page). It never writes: metadata.db and app.db are opened read-only, and the library is only
listed and read. Unlike `calibredb check_library`, it does not vacuum metadata.db.

Prints one line, "@@health " followed by JSON:
  records_missing   records whose folder, format files or cover are missing on disk
  orphans           folders named "<title> (<id>)" that no record points to, each classed by its files:
                    leftover (every book file matches a file of a record, by size then SHA-256),
                    lost (some book file matches nothing in the library), or empty (no book files)
  cover_unflagged   records with a cover.jpg that metadata.db says they lack
  strays            other things in the library folder: files at the top or in an author folder,
                    folders without an id
  corpus_backups    corpus-mcp's metadata.db.before-* backups still in the library folder
  backups           the backup folder corpus-mcp's write commands now use (--backups)
  app_db            Calibre-Web links (shelves, reading status, bookmarks...) to book ids that are gone
Each list is capped at LIMIT entries; `counts` has the full numbers.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys

LIMIT = 500
ID_SUFFIX = re.compile(r'\((\d+)\)$')
# What Calibre itself keeps at the top of a library (calibre/library/check_library.py).
CALIBRE_TOP = {'metadata.db', 'metadata.db-wal', 'metadata.db-shm', 'metadata.db-journal', 'metadata_db_prefs_backup.json',
               'metadata_pre_restore.db', 'full-text-search.db', 'full-text-search.db-wal', 'full-text-search.db-shm',
               '.caltrash', '.calnotes'}
NOT_BOOK_FILES = {'metadata.opf', 'cover.jpg'}


def sha256(path, cache={}):
    key = str(path)
    if key not in cache:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        cache[key] = h.hexdigest()
    return cache[key]


def size_of(path):
    """Bytes under a file or folder, without following links."""
    if path.is_symlink() or not path.is_dir():
        return path.lstat().st_size
    return sum(p.lstat().st_size for p in path.rglob('*') if not p.is_symlink() and p.is_file())


def files_in(folder):
    return sorted(p for p in folder.rglob('*') if p.is_file() and not p.is_symlink())


def capped(items):
    return items[:LIMIT]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('library', type=pathlib.Path)
    parser.add_argument('--app-db', type=pathlib.Path)
    parser.add_argument('--backups', type=pathlib.Path)
    args = parser.parse_args()
    library = args.library.resolve()

    db = sqlite3.connect(f'file:{library / "metadata.db"}?mode=ro', uri=True)
    columns = {r[1] for r in db.execute('PRAGMA table_info(books)')}
    has_cover = 'has_cover' in columns
    records = {}
    for row in db.execute(f'SELECT id, title, path, uuid{", has_cover" if has_cover else ""} FROM books ORDER BY id'):
        records[row[0]] = {'id': row[0], 'title': row[1], 'path': row[2], 'uuid': row[3], 'has_cover': bool(row[4]) if has_cover else None, 'formats': []}
    for book, fmt, name in db.execute('SELECT book, format, name FROM data ORDER BY book, format'):
        if book in records:
            records[book]['formats'].append({'format': fmt, 'file': f'{name}.{fmt.lower()}'})
    db.close()
    by_path = {r['path']: r for r in records.values()}

    # Records against the disk, and every record format file by size, to match orphan files against.
    records_missing, cover_unflagged, by_size = [], [], {}
    for r in records.values():
        folder = library / r['path']
        if not folder.is_dir():
            records_missing.append({'id': r['id'], 'uuid': r['uuid'], 'title': r['title'], 'path': r['path'], 'folder_missing': True,
                                    'formats_missing': [f['format'] for f in r['formats']], 'cover_missing': bool(r['has_cover'])})
            continue
        missing = []
        for f in r['formats']:
            file = folder / f['file']
            if file.is_file():
                by_size.setdefault(file.stat().st_size, []).append((r['id'], f['format'], file))
            else:
                missing.append(f['format'])
        cover = (folder / 'cover.jpg').is_file()
        if missing or (r['has_cover'] and not cover):
            records_missing.append({'id': r['id'], 'uuid': r['uuid'], 'title': r['title'], 'path': r['path'], 'folder_missing': False,
                                    'formats_missing': missing, 'cover_missing': bool(r['has_cover'] and not cover)})
        if r['has_cover'] is False and cover:
            cover_unflagged.append({'id': r['id'], 'title': r['title'], 'path': r['path']})

    def matches(file):
        size = file.stat().st_size
        return [{'id': i, 'format': fmt} for i, fmt, other in by_size.get(size, []) if sha256(other) == sha256(file)]

    orphans, strays, corpus_backups = [], [], []
    for top in sorted(library.iterdir(), key=lambda p: p.name):
        name = top.name
        if name in CALIBRE_TOP:
            continue
        if name.startswith('metadata.db.before-'):
            corpus_backups.append({'name': name, 'bytes': size_of(top)})
            continue
        if top.is_symlink() or not top.is_dir():
            strays.append({'path': name, 'kind': 'file', 'bytes': size_of(top)})
            continue
        for entry in sorted(top.iterdir(), key=lambda p: p.name):
            rel = f'{name}/{entry.name}'
            if rel in by_path:
                continue
            m = ID_SUFFIX.search(entry.name)
            if entry.is_symlink() or not entry.is_dir() or not m:
                strays.append({'path': rel, 'kind': 'folder' if entry.is_dir() else 'file', 'bytes': size_of(entry)})
                continue
            book_id = int(m.group(1))
            book_files = []
            for file in files_in(entry):
                if file.name in NOT_BOOK_FILES:
                    continue
                book_files.append({'file': str(file.relative_to(entry)), 'bytes': file.stat().st_size, 'matches': matches(file)})
            kind = 'empty' if not book_files else 'leftover' if all(f['matches'] for f in book_files) else 'lost'
            record = records.get(book_id)
            orphans.append({'path': rel, 'id': book_id, 'kind': kind, 'files': book_files, 'bytes': size_of(entry),
                            'cover': (entry / 'cover.jpg').is_file(),
                            # The record with this folder's id, if there still is one, and where it lives now.
                            'record': {'title': record['title'], 'path': record['path'], 'folder_exists': (library / record['path']).is_dir()} if record else None})

    app_db = {'checked': False, 'missing_links': []}
    if args.app_db and args.app_db.is_file():
        web = sqlite3.connect(f'file:{args.app_db}?mode=ro', uri=True)
        tables = [t for (t,) in web.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
                  if 'book_id' in {c[1] for c in web.execute(f'PRAGMA table_info("{t}")')}]
        ids = set(records)
        for table in sorted(tables):
            for book_id, n in web.execute(f'SELECT book_id, count(*) FROM "{table}" GROUP BY book_id ORDER BY book_id'):
                if isinstance(book_id, int) and book_id not in ids:
                    app_db['missing_links'].append({'table': table, 'book_id': book_id, 'count': n})
        web.close()
        app_db['checked'] = True

    backups = None
    if args.backups:
        found = sorted(args.backups.glob('metadata.db.before-*')) if args.backups.is_dir() else []
        backups = {'dir': str(args.backups), 'exists': args.backups.is_dir(), 'count': len([p for p in found if not p.name.endswith('.files')]),
                   'bytes': sum(size_of(p) for p in found)}

    report = {
        'version': 1, 'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'library': str(library),
        'records': len(records),
        'counts': {'records_missing': len(records_missing), 'orphans': len(orphans),
                   'orphans_leftover': sum(o['kind'] == 'leftover' for o in orphans), 'orphans_lost': sum(o['kind'] == 'lost' for o in orphans),
                   'orphans_empty': sum(o['kind'] == 'empty' for o in orphans), 'cover_unflagged': len(cover_unflagged),
                   'strays': len(strays), 'corpus_backups': len(corpus_backups), 'app_db_missing_links': len(app_db['missing_links'])},
        'records_missing': capped(records_missing), 'orphans': capped(orphans), 'cover_unflagged': capped(cover_unflagged),
        'strays': capped(strays),
        'corpus_backups': {'count': len(corpus_backups), 'bytes': sum(b['bytes'] for b in corpus_backups)},
        'backups': backups, 'app_db': {**app_db, 'missing_links': capped(app_db['missing_links'])},
    }
    print('@@health ' + json.dumps(report, sort_keys=True), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, sqlite3.Error) as error:
        sys.exit(f'calibre-health: {error}')
