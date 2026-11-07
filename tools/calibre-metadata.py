#!/usr/bin/env python3
"""Preview/apply the reviewed title and author fields through the Calibre metadata API, never direct SQL writes."""
import argparse
import datetime
import json
import os
import pathlib
import sqlite3
import subprocess
import sys


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
        if not isinstance(value, dict) or set(value) != {'title', 'authors'}:
            raise ValueError('Only title and authors may be changed.')
        if not isinstance(value['title'], str) or (key == 'after' and not value['title'].strip()) or len(value['title']) > 1000:
            raise ValueError('Enter a title.')
        if not isinstance(value['authors'], list) or (key == 'after' and not value['authors']) or len(value['authors']) > 100:
            raise ValueError('Enter the authors.')
        if any(not isinstance(a, str) or not a.strip() or len(a) > 300 for a in value['authors']):
            raise ValueError('Invalid author.')
        if any(ord(c) < 32 for t in [value['title'], *value['authors']] for c in t):
            raise ValueError('Control characters are not allowed.')
    after = book['after']
    if any('&' in a for a in after['authors']):
        raise ValueError("Enter authors separately; within a name, use 'and' instead of Calibre's reserved & separator.")
    if any('|' in a for a in after['authors']) or len({a.lower() for a in after['authors']}) != len(after['authors']):
        raise ValueError('Enter each author separately.')

    def read():
        with sqlite3.connect(f'file:{library / "metadata.db"}?mode=ro', uri=True) as db:
            row = db.execute('SELECT uuid,title FROM books WHERE id=?', (book_id,)).fetchone()
            if not row or row[0] != book['uuid']:
                raise ValueError('That Calibre id no longer belongs to this book. Refresh and review again.')
            authors = [r[0] for r in db.execute('SELECT a.name FROM books_authors_link l JOIN authors a ON a.id=l.author WHERE l.book=? ORDER BY l.id', (book_id,))]
            return {'title': row[1], 'authors': authors}

    current = read()
    if current['title'] == after['title'] and [a.replace('|', ',') for a in current['authors']] == after['authors']:
        print('The reviewed metadata is already applied.')
        return
    if current != book['before']:
        raise ValueError('Title or authors changed since this form was loaded. Refresh and review again.')
    if args.calibre_write:
        # Run by calibre-debug so the same API as Calibre's CLI owns all metadata/filesystem writes.
        from calibre.db.legacy import LibraryDatabase
        db = LibraryDatabase(str(library))
        try:
            api = db.new_api
            with api.write_lock:
                mi = api.get_metadata(book_id)
                expected = {'title': book['before']['title'], 'authors': [a.replace('|', ',') for a in book['before']['authors']]}
                if mi.uuid != book['uuid'] or {'title': mi.title, 'authors': mi.authors} != expected:
                    raise ValueError('Metadata changed before the write. Refresh and review again.')
                from calibre.ebooks.metadata import title_sort
                api.set_field('title', {book_id: after['title']})
                api.set_field('authors', {book_id: after['authors']})
                api.set_field('sort', {book_id: title_sort(after['title'], lang=(mi.languages or [None])[0])})
                api.set_field('author_sort', {book_id: api.author_sort_from_authors(after['authors'])})
        finally:
            db.close()
        return
    print(json.dumps({'before': current, 'after': after}, ensure_ascii=False))
    if not args.apply:
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    backup = library / f'metadata.db.before-metadata-{stamp}'
    with sqlite3.connect(f'file:{library / "metadata.db"}?mode=ro', uri=True) as src, sqlite3.connect(backup) as dst:
        src.backup(dst)
    print(f'Backed up metadata.db to {backup}', flush=True)
    # Recheck after the backup. Both preview and apply refuse a stale reviewed value.
    if read() != current:
        raise ValueError('Metadata changed during backup. Refresh and review again.')
    binary = pathlib.Path(os.environ.get('CALIBRE_BIN', '/usr/bin')) / 'calibre-debug'
    command = [str(binary), '-e', str(pathlib.Path(__file__).resolve()), '--', '--calibre-write', str(library)]
    subprocess.run(command, input=json.dumps(plan), text=True, check=True)
    actual = read()
    if actual['title'] != after['title'] or [a.replace('|', ',') for a in actual['authors']] != after['authors']:
        raise ValueError('Calibre did not store the reviewed values; inspect the job and its backup.')
    print('@@change ' + json.dumps({'calibre_id': book_id, 'uuid': book['uuid'], 'title': after['title'], 'metadata': {'before': current, 'after': after}}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, sqlite3.Error, subprocess.CalledProcessError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
