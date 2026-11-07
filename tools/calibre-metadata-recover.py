#!/usr/bin/env python3
"""Run with calibre-debug -e this-file -- LIBRARY BACKUP [--apply].

Recover one reviewed book through Calibre's API using its database and file backup.
Never replace a live metadata.db: other books and later unrelated edits must survive.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import sqlite3


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def inside(root, relative):
    file = (root / relative).resolve()
    if not file.is_relative_to(root.resolve()):
        raise ValueError('Backup or book path escapes its directory.')
    return file


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('library', type=pathlib.Path)
    parser.add_argument('backup', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    files = args.backup.with_name(args.backup.name + '.files')
    manifest = json.loads((files / 'manifest.json').read_text())
    snapshot = files / 'book'
    with sqlite3.connect(f'file:{args.backup}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        saved = dict(db.execute('SELECT * FROM books WHERE id=?', (manifest['book_id'],)).fetchone())
        formats = [tuple(row) for row in db.execute('SELECT format,name FROM data WHERE book=? ORDER BY format', (saved['id'],))]
        names = [r[0].replace('|', ',') for r in db.execute('SELECT a.name FROM books_authors_link l JOIN authors a ON a.id=l.author WHERE l.book=? ORDER BY l.id', (saved['id'],))]
    if saved['uuid'] != manifest['uuid']:
        raise ValueError('Backup identity does not match its manifest.')

    if saved['path'] != manifest['folder']:
        raise ValueError('Backup folder does not match its manifest.')
    if sorted(formats) != sorted(tuple(row) for row in manifest['formats']):
        raise ValueError('Backup formats do not match its manifest.')
    format_files = {f'{name}.{fmt.lower()}': fmt for fmt, name in formats}
    snapshot_files = set()
    for file in snapshot.rglob('*'):
        if file.is_symlink():
            raise ValueError('Backup contains a symlink.')
        if file.is_file():
            snapshot_files.add(str(file.relative_to(snapshot)))
    if snapshot_files != set(manifest['files']):
        raise ValueError('Backup snapshot files do not match its manifest.')
    if not set(format_files).issubset(snapshot_files):
        raise ValueError('An indexed format is missing from the backup snapshot.')
    for name, expected in manifest['files'].items():
        if digest(inside(snapshot, name)) != expected:
            raise ValueError('Backup file checksum failed: ' + name)

    from calibre.db.legacy import LibraryDatabase
    from calibre.utils.date import UNDEFINED_DATE
    db = LibraryDatabase(str(args.library))
    try:
        api = db.new_api
        with api.write_lock:
            book_id = saved['id']
            current = api.get_metadata(book_id)
            if current.uuid != saved['uuid']:
                raise ValueError('That id belongs to a different book; recovery refused.')
            folder = inside(args.library, api.field_for('path', book_id))
            # The writer only renames content. A changed existing file may be a later user edit.
            for name, expected in manifest['files'].items():
                if name == 'metadata.opf':
                    continue
                if name in format_files:
                    current_path = api.format_abspath(book_id, format_files[name])
                    file = pathlib.Path(current_path) if current_path else None
                else:
                    file = inside(folder, name)
                if file and file.exists() and digest(file) != expected:
                    raise ValueError('Current content differs from the backup; review it before recovery: ' + name)
            print(json.dumps({'book_id': book_id, 'uuid': saved['uuid'], 'current': {'title': current.title, 'authors': current.authors, 'pubdate': str(current.pubdate)}, 'restore': {'title': saved['title'], 'authors': names, 'pubdate': saved['pubdate']}, 'apply': args.apply}))
            if not args.apply:
                return
            # Field writes use the current catalogue paths, so Calibre reverses its folder renames.
            api.set_field('title', {book_id: saved['title']})
            api.set_field('authors', {book_id: names})
            date = datetime.datetime.fromisoformat(saved['pubdate']) if saved['pubdate'] else UNDEFINED_DATE
            api.set_field('pubdate', {book_id: date})
            api.set_field('sort', {book_id: saved['sort']})
            api.set_field('author_sort', {book_id: saved['author_sort']})
            restored_path = api.field_for('path', book_id)
            if restored_path != saved['path']:
                raise ValueError(f"Calibre restored a different folder: {restored_path!r}; expected {saved['path']!r}. Metadata may already have changed; no backup files were restored.")
            for name, fmt in format_files.items():
                current_path = api.format_abspath(book_id, fmt)
                if not current_path or not pathlib.Path(current_path).exists():
                    with open(inside(snapshot, name), 'rb') as stream:
                        api.add_format(book_id, fmt, stream, replace=True, run_hooks=False)
                if digest(api.format_abspath(book_id, fmt)) != manifest['files'][name]:
                    raise ValueError('Recovered format checksum failed: ' + fmt)
            folder = inside(args.library, api.field_for('path', book_id))
            for name, expected in manifest['files'].items():
                if name in format_files or name == 'metadata.opf':
                    continue
                file = inside(folder, name)
                if not file.exists():
                    if name == 'cover.jpg':
                        api.set_cover({book_id: inside(snapshot, name).read_bytes()})
                    else:
                        file.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(inside(snapshot, name), file)
                if digest(file) != expected:
                    raise ValueError('Recovered file checksum failed: ' + name)
            api.dump_metadata([book_id])
            restored = api.get_metadata(book_id)
            if restored.title != saved['title'] or restored.authors != names:
                raise ValueError('Recovered metadata does not match its backup.')
            print(json.dumps({'recovered': True, 'book_id': book_id, 'filesVerified': len(manifest['files'])}))
    finally:
        db.close()


if __name__ == '__main__':
    main()
