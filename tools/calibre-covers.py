#!/usr/bin/env python3
"""Set the covers a corpus-mcp covers preview found. Run with calibre-debug -e SCRIPT -- LIBRARY --apply.

Reads the plan on stdin:
{"library": "main", "books": [{"calibre_id", "uuid", "title", "cover": {"source", "label", "page_url",
"sha256", "ext", "old_cover_sha256"}, "cover_base64": "..."}, ...]}.

Each book's cover is set only if the book is still the one previewed (same uuid) and its cover.jpg is
still the one judged plain (old_cover_sha256; null when it had none). metadata.db is backed up first and
each replaced cover.jpg is saved beside the backup. Prints an "@@change" line per book: cover_set, or
cover_skipped with the reason.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys

MAX_BOOKS = 2000
MAX_COVER_BYTES = 10 * 1024 * 1024


class CoverPlanError(Exception):
    """A plan that can't be applied as sent."""


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_plan(stream):
    try:
        plan = json.load(stream)
    except json.JSONDecodeError as error:
        raise CoverPlanError('Send a valid JSON covers plan.') from error
    books = plan.get('books') if isinstance(plan, dict) else None
    if not isinstance(books, list) or not books:
        raise CoverPlanError('The plan names no books.')
    if len(books) > MAX_BOOKS:
        raise CoverPlanError(f'Set at most {MAX_BOOKS} covers at a time.')
    seen = set()
    for b in books:
        if not isinstance(b, dict) or type(b.get('calibre_id')) is not int or b['calibre_id'] < 1:
            raise CoverPlanError('Invalid book in the plan.')
        if b['calibre_id'] in seen:
            raise CoverPlanError(f'Book {b["calibre_id"]} appears twice.')
        seen.add(b['calibre_id'])
        if not isinstance(b.get('uuid'), str) or not re.fullmatch(r'[0-9a-f-]{36}', b['uuid']) or not isinstance(b.get('title'), str):
            raise CoverPlanError('Invalid book identity in the plan.')
        cover = b.get('cover')
        if (not isinstance(cover, dict) or cover.get('ext') not in ('jpg', 'png') or not isinstance(cover.get('sha256'), str)
                or not re.fullmatch(r'[0-9a-f]{64}', cover['sha256'])
                or not (cover.get('old_cover_sha256') is None or (isinstance(cover['old_cover_sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', cover['old_cover_sha256'])))):
            raise CoverPlanError(f'Invalid cover for book {b["calibre_id"]}.')
        raw = b.get('cover_base64')
        if not isinstance(raw, str) or not raw or len(raw) > MAX_COVER_BYTES * 4 // 3 + 4:
            raise CoverPlanError(f'Missing or oversized cover for book {b["calibre_id"]}.')
        try:
            data = base64.b64decode(raw, validate=True)
        except ValueError as error:
            raise CoverPlanError(f'The cover for book {b["calibre_id"]} is not valid base64.') from error
        if sha256(data) != cover['sha256']:
            raise CoverPlanError(f'The cover for book {b["calibre_id"]} does not match its checksum.')
        if not data.startswith(b'\xff\xd8' if cover['ext'] == 'jpg' else b'\x89PNG\r\n\x1a\n'):
            raise CoverPlanError(f'The cover for book {b["calibre_id"]} is not the image type it claims.')
        b['data'] = data
    return books


def event(calibre_id, uuid, title, **fields):
    print('@@change ' + json.dumps({'calibre_id': calibre_id, 'uuid': uuid, 'title': title, **fields}, default=str), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('library', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        raise CoverPlanError('The covers preview runs in corpus-mcp; this script only applies it (--apply).')
    books = read_plan(sys.stdin)

    from calibre.db.legacy import LibraryDatabase
    db = LibraryDatabase(str(args.library))
    try:
        api = db.new_api
        with api.write_lock:
            ready = []
            for b in books:
                book_id, uuid, title = b['calibre_id'], b['uuid'], b['title']
                if not api.has_id(book_id) or api.field_for('uuid', book_id) != uuid:
                    event(book_id, uuid, title, cover_skipped='The book is no longer in Calibre under this id. Preview again.')
                    continue
                folder = args.library / api.field_for('path', book_id)
                current = folder / 'cover.jpg'
                old = sha256(current.read_bytes()) if current.is_file() else None
                if old != b['cover']['old_cover_sha256']:
                    event(book_id, uuid, title, cover_skipped='Its cover changed since the preview. Preview again.')
                    continue
                ready.append((b, current))
            if not ready:
                return
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
            # corpus-source.sh sets CORPUS_BACKUP_DIR beside the library; run by hand, the library itself.
            backup = pathlib.Path(os.environ.get('CORPUS_BACKUP_DIR') or args.library) / ('metadata.db.before-covers-' + stamp)
            with sqlite3.connect(f'file:{args.library}/metadata.db?mode=ro', uri=True) as src, sqlite3.connect(backup) as dst:
                src.backup(dst)
            saved = backup.with_name(backup.name + '.files')
            saved.mkdir(mode=0o700)
            print(f'Backed up metadata.db to {backup} and the covers being replaced to {saved}', flush=True)
            for b, current in ready:
                book_id = b['calibre_id']
                if current.is_file():
                    shutil.copy2(current, saved / f'{book_id}-cover.jpg')
                api.set_cover({book_id: b['data']})
                event(book_id, b['uuid'], b['title'], cover_set={'source': b['cover'].get('source', 'otl'), 'label': str(b['cover'].get('label', '')), 'backup': str(saved)})
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except CoverPlanError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
