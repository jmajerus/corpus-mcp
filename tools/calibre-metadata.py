#!/usr/bin/env python3
"""Preview/apply the reviewed title, author, and publication-year fields through the Calibre metadata API, never direct SQL writes."""
import argparse
import datetime
import json
import os
import pathlib
import shutil
import hashlib
import sqlite3
import subprocess
import sys


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--calibre-write', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('library')
    args = parser.parse_args()
    library = pathlib.Path(args.library)
    plan = json.load(sys.stdin)
    books = plan.get('books')
    if not isinstance(books, list) or len(books) != 1:
        raise ValueError('Review one book at a time.')
    book = books[0]
    book_id = book.get('calibre_id')
    if type(book_id) is not int or book_id < 1 or not isinstance(book.get('uuid'), str):
        raise ValueError('Invalid book identity.')
    for key in ['before', 'after']:
        value = book.get(key)
        if not isinstance(value, dict) or set(value) != {'title', 'authors', 'year'}:
            raise ValueError('Only title, authors, and publication year may be changed.')
        if not isinstance(value['title'], str) or (key == 'after' and not value['title'].strip()) or len(value['title']) > 1000:
            raise ValueError('Enter a title.')
        if not isinstance(value['authors'], list) or (key == 'after' and not value['authors']) or len(value['authors']) > 100:
            raise ValueError('Enter the authors.')
        if value['year'] is not None and (type(value['year']) is not int or not 1001 <= value['year'] <= 9999):
            raise ValueError('Enter a publication year from 1001 to 9999, or leave it blank.')
        if any(not isinstance(a, str) or not a.strip() or len(a) > 300 for a in value['authors']):
            raise ValueError('Invalid author.')
        if any(ord(c) < 32 for t in [value['title'], *value['authors']] for c in t):
            raise ValueError('Control characters are not allowed.')
    after = book['after']
    if any('&' in a for a in after['authors']):
        raise ValueError("Enter authors separately; within a name, use 'and' instead of Calibre's reserved & separator.")
    if any('|' in a for a in after['authors']) or len({a.lower() for a in after['authors']}) != len(after['authors']):
        raise ValueError('Enter each author separately.')

    def year_of(value):
        try:
            year = value.year if hasattr(value, 'year') else int(str(value)[:4])
            return year if year > 1000 else None
        except (ValueError, TypeError):
            return None

    def read():
        with sqlite3.connect(f'file:{library / "metadata.db"}?mode=ro', uri=True) as db:
            row = db.execute('SELECT uuid,title,pubdate FROM books WHERE id=?', (book_id,)).fetchone()
            if not row or row[0] != book['uuid']:
                raise ValueError('That Calibre id no longer belongs to this book. Refresh and review again.')
            authors = [r[0] for r in db.execute('SELECT a.name FROM books_authors_link l JOIN authors a ON a.id=l.author WHERE l.book=? ORDER BY l.id', (book_id,))]
            return {'title': row[1], 'authors': authors, 'year': year_of(row[2])}

    current = read()
    if current['year'] == after['year'] and current['title'] == after['title'] and [a.replace('|', ',') for a in current['authors']] == after['authors']:
        print('The reviewed metadata is already applied.')
        return
    if current != book['before']:
        raise ValueError('Title, authors, or publication year changed since this form was loaded. Refresh and review again.')
    if args.calibre_write:
        # Run by calibre-debug so the same API as Calibre's CLI owns all metadata/filesystem writes.
        from calibre.db.legacy import LibraryDatabase
        db = LibraryDatabase(str(library))
        try:
            api = db.new_api
            with api.write_lock:
                mi = api.get_metadata(book_id)
                expected = {'title': book['before']['title'], 'authors': [a.replace('|', ',') for a in book['before']['authors']], 'year': book['before']['year']}
                if mi.uuid != book['uuid'] or {'title': mi.title, 'authors': mi.authors, 'year': year_of(mi.pubdate)} != expected:
                    raise ValueError('Metadata changed before the write. Refresh and review again.')
                from calibre.ebooks.metadata import title_sort
                from calibre.utils.date import UNDEFINED_DATE
                if after['year'] != current['year']:
                    date = UNDEFINED_DATE if after['year'] is None else datetime.datetime(after['year'], 1, 1, 12, tzinfo=datetime.timezone.utc)
                    api.set_field('pubdate', {book_id: date})
                if after['title'] != current['title']:
                    api.set_field('title', {book_id: after['title']})
                    api.set_field('sort', {book_id: title_sort(after['title'], lang=(mi.languages or [None])[0])})
                if after['authors'] != [a.replace('|', ',') for a in current['authors']]:
                    api.set_field('authors', {book_id: after['authors']})
                    api.set_field('author_sort', {book_id: api.author_sort_from_authors(after['authors'])})
        finally:
            db.close()
        return
    print(json.dumps({'before': current, 'after': after}, ensure_ascii=False))
    if not args.apply:
        return
    binary = pathlib.Path(os.environ.get('CALIBRE_BIN', '/usr/bin')) / 'calibre-debug'
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError(f'Calibre runtime is unavailable: {binary}. No metadata was written.')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    backup = library / f'metadata.db.before-metadata-{stamp}'
    with sqlite3.connect(f'file:{library / "metadata.db"}?mode=ro', uri=True) as src, sqlite3.connect(backup) as dst:
        src.backup(dst)
    # A database alone cannot recover book files after Calibre has renamed their folders.
    files = backup.with_name(backup.name + '.files')
    files.mkdir(mode=0o700)
    with sqlite3.connect(backup) as db:
        folder = db.execute('SELECT path FROM books WHERE id=?', (book_id,)).fetchone()[0]
        formats = db.execute('SELECT format,name FROM data WHERE book=? ORDER BY format', (book_id,)).fetchall()
    original = (library / folder).resolve()
    if not original.is_relative_to(library.resolve()):
        raise ValueError('Book folder is outside the library; no metadata was written.')
    if original.exists():
        shutil.copytree(original, files / 'book', symlinks=True)
    else:
        (files / 'book').mkdir()
    manifest = {'book_id': book_id, 'uuid': book['uuid'], 'folder': folder, 'formats': formats, 'files': {}}
    for file in (files / 'book').rglob('*'):
        if file.is_symlink():
            raise ValueError('Book contains a symlink; no metadata was written.')
        if file.is_file():
            manifest['files'][str(file.relative_to(files / 'book'))] = digest(file)
    for fmt, name in formats:
        if f'{name}.{fmt.lower()}' not in manifest['files']:
            raise ValueError('An indexed format is missing from the book backup; no metadata was written.')
    (files / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Backed up metadata.db to {backup}; book files to {files}', flush=True)
    # Recheck after the backup. Both preview and apply refuse a stale reviewed value.
    if read() != current:
        raise ValueError('Metadata changed during backup. Refresh and review again.')
    command = [str(binary), '-e', str(pathlib.Path(__file__).resolve()), '--', '--calibre-write', str(library)]
    result = subprocess.run(command, input=json.dumps(plan), text=True)
    actual = read()
    matches = actual['year'] == after['year'] and actual['title'] == after['title'] and [a.replace('|', ',') for a in actual['authors']] == after['authors']
    if actual != current:
        correction = {'before': current, 'after': actual}
        if result.returncode or not matches:
            correction['partial'] = True
        print('@@change ' + json.dumps({'calibre_id': book_id, 'uuid': book['uuid'], 'title': actual['title'], 'metadata': correction}, ensure_ascii=False), flush=True)
    if result.returncode or not matches:
        print(f'Metadata apply did not complete. Keep {backup} and {files}. Recover this book with calibre-metadata-recover.py after reviewing the failure; do not replace the live database alone.', file=sys.stderr)
        result.check_returncode()
        raise ValueError('Calibre did not store the reviewed values; inspect the job and its backup.')



if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, sqlite3.Error, subprocess.CalledProcessError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
