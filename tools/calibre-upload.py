#!/usr/bin/env python3
"""Native Calibre upload preview and apply. Run with calibre-debug -e SCRIPT -- LIBRARY [--apply].

Reads a batch upload plan on stdin:
{"library": "main", "items": [{"id", "filename", "ext", "format", "target_formats", "primary_format",
"converts_to", "sha256", "size", "action": "add_book" | "add_format", "target": {id, uuid, title} | null,
"title", "authors", "year", "tags", "known_matches": [{id, uuid}], "data_base64": "..."}, ...]}.

Preview inspects each file (running import plugins such as DeDRM on .kfx-zip when available, sniffing
DRM and format validity) and checks the live Calibre library for exact file duplicates, unreviewed
title/author/identifier matches, and target book state. Apply re-verifies each reviewed item, backs up
metadata.db (and target book folders for add_format), converts MOBI/AZW/AZW3/PRC/KFX files to EPUB or
PDF, and writes the new books or formats through Calibre's database API.
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
import subprocess
import sys
import tempfile
import unicodedata
import zipfile

MAX_ITEMS = 100
ALLOWED_EXTS = {'epub', 'pdf', 'mobi', 'azw', 'azw3', 'prc', 'kfx', 'kfx-zip'}


class UploadReviewError(Exception):
    """An expected validation failure that an operator can resolve."""


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def inside(root, relative):
    p = root / relative
    if p.is_symlink() or not p.resolve().is_relative_to(root.resolve()):
        raise UploadReviewError('Book path escapes the library or contains a symlink.')
    return p


def normal(text):
    decomposed = unicodedata.normalize('NFKD', str(text or ''))
    stripped = ''.join(ch for ch in decomposed if unicodedata.category(ch) != 'Mn').lower()
    return re.sub(r'[^\w]+', ' ', stripped, flags=re.UNICODE).strip()


def valid_isbn(raw):
    isbn = re.sub(r'^isbn(-1[03])?:?', '', str(raw or ''), flags=re.I)
    isbn = re.sub(r'[\s\-\u2010\u2011\u2013]', '', isbn).upper()
    if re.fullmatch(r'\d{9}[\dX]', isbn):
        total = sum((10 if c == 'X' else int(c)) * (10 - i) for i, c in enumerate(isbn))
        return isbn if total % 11 == 0 else None
    if re.fullmatch(r'\d{13}', isbn):
        total = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(isbn))
        return isbn if total % 10 == 0 else None
    return None


def isbn13(isbn):
    if len(isbn) == 13:
        return isbn
    body = '978' + isbn[:9]
    total = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(body))
    return f'{body}{(10 - (total % 10)) % 10}'


def identifier_key(id_type, value):
    t = str(id_type or '').lower()
    if t in ('citekey', 'calibre'):
        return None
    m = re.match(r'^urn:(asin|isbn):(.+)$', str(value or '').strip(), flags=re.I)
    kind = m.group(1).lower() if m else ('asin' if 'asin' in t or t.startswith('amazon') else 'isbn' if 'isbn' in t else t)
    raw = re.sub(r'[\s-]', '', (m.group(2) if m else str(value or ''))).lower()
    if not raw:
        return None
    checked = valid_isbn(raw) if kind == 'isbn' else None
    return ('identifier', kind, isbn13(checked) if checked else raw)


def valid_ref(ref):
    return isinstance(ref, dict) and type(ref.get('id')) is int and ref['id'] >= 1 and isinstance(ref.get('uuid'), str) and bool(ref['uuid'])


def read_plan(stream):
    """Validate the upload batch shape before Calibre opens."""
    try:
        plan = json.load(stream)
    except json.JSONDecodeError as error:
        raise UploadReviewError('Send a valid JSON upload plan.') from error
    items = plan.get('items') if isinstance(plan, dict) else None
    if not isinstance(items, list) or not items:
        raise UploadReviewError('Select at least one file to upload.')
    if len(items) > MAX_ITEMS:
        raise UploadReviewError(f'Upload at most {MAX_ITEMS} files at a time.')
    seen_ids, seen_hashes, seen_targets = set(), set(), set()
    for item in items:
        if not isinstance(item, dict):
            raise UploadReviewError('Invalid upload item.')
        item_id = item.get('id')
        ext = item.get('ext')
        sha = item.get('sha256')
        size = item.get('size')
        action = item.get('action')
        filename = item.get('filename')
        if not isinstance(item_id, str) or not item_id or not isinstance(filename, str) or not filename.strip():
            raise UploadReviewError('Invalid upload file identity.')
        if ext not in ALLOWED_EXTS:
            raise UploadReviewError(f'Unsupported file extension: {ext!r}')
        if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{64}', sha) or type(size) is not int or size < 1:
            raise UploadReviewError('Invalid file checksum or size.')
        if item_id in seen_ids or sha in seen_hashes:
            raise UploadReviewError('Each uploaded file may appear only once in a batch.')
        seen_ids.add(item_id)
        seen_hashes.add(sha)
        if action not in ('add_book', 'add_format'):
            raise UploadReviewError('Choose add_book or add_format for each file.')
        if 'reviewed' in item and not isinstance(item['reviewed'], str):
            raise UploadReviewError('Invalid review fingerprint.')
        if not isinstance(item.get('data_base64'), str) or not item['data_base64']:
            raise UploadReviewError(f'Missing file payload for {filename}.')
        if action == 'add_format':
            target = item.get('target')
            if not valid_ref(target):
                raise UploadReviewError('Invalid target book identity for add_format.')
            primary = item.get('primary_format')
            if primary not in ('EPUB', 'PDF'):
                raise UploadReviewError('Invalid primary format.')
            key = (target['id'], primary)
            if key in seen_targets:
                raise UploadReviewError(f'More than one file adds {primary} to book {target["id"]}.')
            seen_targets.add(key)
        else:
            title = item.get('title')
            authors = item.get('authors')
            year = item.get('year')
            tags = item.get('tags', [])
            if not isinstance(title, str) or not title.strip() or len(title) > 1000 or any(ord(c) < 32 for c in title):
                raise UploadReviewError('Enter a valid title.')
            if not isinstance(authors, list) or not authors or len(authors) > 100:
                raise UploadReviewError('Enter at least one author.')
            if any(not isinstance(a, str) or not a.strip() or len(a) > 300 or '&' in a or '|' in a or any(ord(c) < 32 for c in a) for a in authors):
                raise UploadReviewError('Invalid author list.')
            if len({a.strip().lower() for a in authors}) != len(authors):
                raise UploadReviewError('An author is listed more than once.')
            if year is not None and (type(year) is not int or not 1001 <= year <= 9999):
                raise UploadReviewError('Enter a publication year from 1001 to 9999, or leave it blank.')
            if not isinstance(tags, list) or any(not isinstance(t, str) or any(ord(c) < 32 for c in t) for t in tags):
                raise UploadReviewError('Invalid tags list.')
            known = item.get('known_matches', [])
            if not isinstance(known, list) or not all(valid_ref(r) for r in known):
                raise UploadReviewError('Invalid known_matches list.')
    return items


def sniff_file(path, ext):
    """Inspect a file on disk: returns (source_fmt, convert_to, problem)."""
    with path.open('rb') as f:
        head = f.read(128)
        if head.startswith(b'\xeaDRMION\xee'):
            return 'KFX', 'EPUB', 'DRM-encrypted (KFX DRMION); download it again and add it through DeDRM.'
        if head.startswith(b'CONT'):
            data = head + f.read()
            replica = b'%PDF-' in data and (b'yj_textbook' in data or b'yj_fixed_layout' in data)
            return 'KFX', ('PDF' if replica else 'EPUB'), None
        if head[60:68] in (b'BOOKMOBI', b'TEXtREAd'):
            f.seek(int.from_bytes(head[78:82], 'big'))
            record = f.read(16)
            encrypted = bool(int.from_bytes(record[12:14], 'big'))
            fmt = 'MOBI' if ext in ('epub', 'pdf', 'kfx', 'kfx-zip') else ext.upper()
            return fmt, 'EPUB', ('DRM-encrypted (MOBI/AZW); download it again and add it through DeDRM.' if encrypted else None)
    if ext == 'epub':
        try:
            with zipfile.ZipFile(path) as archive:
                if archive.testzip() is not None or 'META-INF/container.xml' not in archive.namelist():
                    return 'EPUB', None, 'Damaged EPUB archive: missing container.xml or corrupt zip entry.'
                if 'META-INF/encryption.xml' in archive.namelist():
                    enc = archive.read('META-INF/encryption.xml').decode('utf-8', errors='ignore')
                    if re.search(r'<EncryptedData\b', enc, flags=re.I) and re.search(r'\.(x?html?|xml|ncx|opf)\b', enc, flags=re.I):
                        return 'EPUB', None, 'DRM-encrypted EPUB; remove DRM before uploading.'
        except (OSError, zipfile.BadZipFile) as error:
            return 'EPUB', None, f'Damaged EPUB archive: {error}'
        return 'EPUB', None, None
    if ext == 'pdf':
        with path.open('rb') as f:
            if b'%PDF-' not in f.read(1024):
                return 'PDF', None, 'Damaged PDF: missing %PDF- header.'
        return 'PDF', None, None
    return ext.upper(), 'EPUB', f'Unrecognized {ext.upper()} file.'


def stage_and_import_plugins(item, work_dir):
    """Write the uploaded bytes to work_dir, verify checksum, and run Calibre's import plugins (DeDRM / KFX Input) when applicable."""
    raw_path = work_dir / f'{item["id"]}.{item["ext"]}'
    try:
        raw_bytes = base64.b64decode(item['data_base64'], validate=True)
    except Exception as error:
        raise UploadReviewError(f'Invalid base64 payload for {item["filename"]}.') from error
    raw_path.write_bytes(raw_bytes)
    if raw_path.stat().st_size != item['size'] or digest(raw_path) != item['sha256']:
        raise UploadReviewError(f'File checksum mismatch for {item["filename"]}.')

    effective_path = raw_path
    effective_ext = item['ext']
    if effective_ext in ('kfx-zip', 'kfx', 'azw', 'azw3', 'mobi', 'prc'):
        try:
            from calibre.customize.ui import run_plugins_on_import
            imported = pathlib.Path(run_plugins_on_import(str(raw_path)))
            if imported.is_file() and imported.stat().st_size > 0:
                effective_path = imported
                effective_ext = imported.suffix.lstrip('.').lower() or effective_ext
        except Exception:
            pass
    if effective_ext == 'kfx-zip':
        # Check whether the kfx-zip archive itself contains an unencrypted CONT container or is still locked.
        try:
            with zipfile.ZipFile(effective_path) as zf:
                names = zf.namelist()
                if any(zf.read(n)[:8].startswith(b'\xeaDRMION\xee') for n in names):
                    return effective_path, 'KFX', 'EPUB', 'Still encrypted (.kfx-zip DRMION); check that the Kindle keyfile is imported into DeDRM.'
                cont = next((n for n in names if zf.read(n)[:4] == b'CONT'), None)
                if cont:
                    extracted = work_dir / f'{item["id"]}-extracted.kfx'
                    extracted.write_bytes(zf.read(cont))
                    effective_path = extracted
                    effective_ext = 'kfx'
                else:
                    return effective_path, 'KFX', 'EPUB', 'Still encrypted (.kfx-zip); check that DeDRM and KFX Input are installed.'
        except Exception as error:
            return effective_path, 'KFX', 'EPUB', f'Could not read KFX-ZIP archive: {error}'

    source_fmt, convert_to, problem = sniff_file(effective_path, effective_ext)
    return effective_path, source_fmt, convert_to, problem


def convert_ebook(source_path, source_fmt, convert_to, work_dir, item_id):
    """Convert MOBI/AZW/AZW3/PRC/KFX to EPUB or extract a print-replica PDF, as calibre-convert.sh does."""
    bin_dir = pathlib.Path(os.environ.get('CALIBRE_BIN', '/usr/bin'))
    limit = int(os.environ.get('CONVERT_TIMEOUT', '600'))
    actual_convert = convert_to
    if actual_convert == 'PDF':
        kfx_dir = work_dir / f'kfx-{item_id}'
        kfx_dir.mkdir(exist_ok=True)
        kfx_copy = kfx_dir / 'book.kfx'
        out_pdf = work_dir / f'{item_id}.pdf'
        shutil.copy2(source_path, kfx_copy)
        proc = subprocess.run(
            [str(bin_dir / 'calibre-debug'), '-r', 'KFX Input', '--', '-p', str(kfx_copy), str(out_pdf)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=limit, check=False,
        )
        shutil.rmtree(kfx_dir, ignore_errors=True)
        if proc.returncode == 0 and out_pdf.is_file() and out_pdf.stat().st_size > 0:
            return 'PDF', out_pdf
        if proc.returncode == 0:
            actual_convert = 'EPUB'
        else:
            raise UploadReviewError(f'Print-replica PDF extraction failed for {source_path.name}.')

    if actual_convert == 'EPUB':
        out_epub = work_dir / f'{item_id}.epub'
        proc = subprocess.run(
            [str(bin_dir / 'ebook-convert'), str(source_path), str(out_epub)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=limit, check=False,
        )
        if proc.returncode != 0 or not out_epub.is_file() or out_epub.stat().st_size == 0:
            raise UploadReviewError(f'Conversion from {source_fmt} to EPUB failed.')
        return 'EPUB', out_epub

    return None, None


class UploadReview:
    """One uploaded file's source check, target verification, and fingerprint under Calibre's write lock."""

    def __init__(self, api, library, item, work_dir):
        self.api, self.library, self.item, self.work_dir = api, library, item, work_dir
        self.effective_path, self.source_format, self.convert_to, sniff_problem = stage_and_import_plugins(item, work_dir)
        self.effective_sha256 = digest(self.effective_path)
        self.effective_size = self.effective_path.stat().st_size
        self.blockers = [sniff_problem] if sniff_problem else []

        desired = [self.source_format]
        if self.convert_to and self.convert_to not in desired:
            desired.append(self.convert_to)
        self.desired_formats = desired

        # Check all existing books in the live library for exact file matches or unreviewed metadata matches.
        want_hashes = {item['sha256'], self.effective_sha256}
        want_sizes = {item['size'], self.effective_size}
        want_title = normal(item.get('title', ''))
        want_authors = '|'.join(sorted(normal(a) for a in item.get('authors', []) if normal(a) and normal(a) != 'unknown'))
        known_ids = {(r['id'], r['uuid']) for r in item.get('known_matches', [])}

        for book_id in sorted(api.all_book_ids()):
            mi = api.get_metadata(book_id)
            root = inside(library, api.field_for('path', book_id))
            for fmt in (api.formats(book_id) or ()):
                fpath = pathlib.Path(api.format_abspath(book_id, fmt))
                if fpath.is_file() and fpath.stat().st_size in want_sizes and digest(inside(root, fpath.relative_to(root))) in want_hashes:
                    self.blockers.append(f'Identical {fmt.upper()} file is already in Calibre book {book_id} ({mi.title}).')
            if item['action'] == 'add_book' and (book_id, mi.uuid) not in known_ids:
                b_title = normal(mi.title)
                b_authors = '|'.join(sorted(normal(a) for a in (mi.authors or []) if normal(a) and normal(a) != 'unknown'))
                if want_title and b_title == want_title and want_authors and b_authors == want_authors:
                    self.blockers.append(f'Matches Calibre book {book_id} ({mi.title}) in the live library. Refresh Corpus and review the match first.')

        self.target_state = None
        if item['action'] == 'add_format':
            target = item['target']
            if not api.has_id(target['id']):
                self.blockers.append(f'Calibre book {target["id"]} no longer exists. Refresh and review again.')
                self.add_formats = []
            else:
                km = api.get_metadata(target['id'])
                if km.uuid != target['uuid']:
                    self.blockers.append(f'Calibre id {target["id"]} belongs to a different book. Refresh and review again.')
                existing_fmts = sorted(f.upper() for f in (api.formats(target['id']) or ()))
                self.add_formats = [f for f in self.desired_formats if f not in existing_fmts]
                primary = self.convert_to or self.source_format
                if primary in existing_fmts or not self.add_formats:
                    self.blockers.append(f'Calibre book {target["id"]} ({km.title}) already has {primary}.')
                self.target_state = {'id': target['id'], 'uuid': km.uuid, 'title': km.title, 'formats': existing_fmts}
        else:
            self.add_formats = list(self.desired_formats)

        plan_clean = {k: v for k, v in item.items() if k not in ('data_base64', 'reviewed')}
        self.fingerprint = hashlib.sha256(
            json.dumps([plan_clean, self.source_format, self.convert_to, self.add_formats, self.target_state], sort_keys=True, default=str).encode()
        ).hexdigest()

    def summary(self):
        plan_clean = {k: v for k, v in self.item.items() if k != 'data_base64'}
        plan_clean['reviewed'] = self.fingerprint
        return {
            'plan': plan_clean,
            'action': self.item['action'],
            'filename': self.item['filename'],
            'source_format': self.source_format,
            'convert_to': self.convert_to,
            'add_formats': self.add_formats,
            'target': self.target_state,
            'blockers': self.blockers,
        }


def event(calibre_id, uuid, title, **fields):
    print('@@change ' + json.dumps({'calibre_id': calibre_id, 'uuid': uuid, 'title': title, **fields}, default=str), flush=True)


def apply_review(api, library, review, saved, backup):
    """Execute one reviewed upload (add_format or add_book) after metadata.db backup."""
    item = review.item
    files_by_fmt = {review.source_format: review.effective_path}
    if review.convert_to and review.convert_to in review.add_formats:
        conv_fmt, conv_path = convert_ebook(review.effective_path, review.source_format, review.convert_to, review.work_dir, item['id'])
        if conv_fmt and conv_path:
            files_by_fmt[conv_fmt] = conv_path
            if conv_fmt != review.convert_to:
                review.add_formats = [conv_fmt if f == review.convert_to else f for f in review.add_formats]

    if item['action'] == 'add_format':
        target = review.target_state
        book_id = target['id']
        folder = api.field_for('path', book_id)
        book_dir = saved / str(book_id)
        if not book_dir.exists():
            shutil.copytree(inside(library, folder), book_dir, symlinks=True)
        added_fmts = []
        for fmt in review.add_formats:
            fpath = files_by_fmt.get(fmt)
            if not fpath:
                continue
            expected = digest(fpath)
            if not api.add_format(book_id, fmt, str(fpath), replace=False, run_hooks=False):
                raise UploadReviewError(f'Could not add format {fmt} to book {book_id}.')
            if digest(pathlib.Path(api.format_abspath(book_id, fmt))) != expected:
                raise UploadReviewError(f'Checksum verification failed after adding {fmt} to book {book_id}.')
            added_fmts.append(fmt)
        api.dump_metadata([book_id])
        primary_added = added_fmts[-1] if added_fmts else review.source_format
        event(
            book_id, target['uuid'], target['title'],
            added_format=primary_added.lower(),
            source_format=review.source_format.lower(),
            upload_applied={'id': item['id'], 'action': 'add_format', 'formats': added_fmts, 'backup': str(backup)},
        )
        return

    # action == 'add_book'
    from calibre.ebooks.metadata.book.base import Metadata
    from calibre.ebooks.metadata import title_sort
    from calibre.utils.date import UNDEFINED_DATE

    title = item['title'].strip()
    authors = [a.strip() for a in item['authors'] if a.strip()]
    mi = Metadata(title, authors)
    cover_bytes = None
    try:
        from calibre.ebooks.metadata.meta import get_metadata
        with review.effective_path.open('rb') as stream:
            ext_mi = get_metadata(stream, stream_type=review.source_format.lower(), use_libprs_metadata=True)
        for field in ('publisher', 'comments', 'series', 'series_index', 'languages'):
            val = getattr(ext_mi, field, None)
            if val:
                setattr(mi, field, val)
        if getattr(ext_mi, 'identifiers', None):
            mi.set_identifiers(dict(ext_mi.identifiers))
        if getattr(ext_mi, 'cover_data', None) and ext_mi.cover_data[1]:
            cover_bytes = ext_mi.cover_data[1]
    except Exception:
        pass

    mi.title = title
    mi.authors = authors
    mi.tags = [t.strip() for t in item.get('tags', []) if t.strip()]
    year = item.get('year')
    mi.pubdate = UNDEFINED_DATE if year is None else datetime.datetime(year, 1, 1, 12, tzinfo=datetime.timezone.utc)
    lang = (getattr(mi, 'languages', None) or [None])[0]
    mi.title_sort = title_sort(title, lang=lang)
    mi.author_sort = api.author_sort_from_authors(authors)

    book_id = api.create_book_entry(mi)
    uuid = api.field_for('uuid', book_id)
    added_fmts = []
    for fmt in review.add_formats:
        fpath = files_by_fmt.get(fmt)
        if not fpath:
            continue
        expected = digest(fpath)
        if not api.add_format(book_id, fmt, str(fpath), replace=False, run_hooks=False):
            raise UploadReviewError(f'Could not add {fmt} to new book {book_id}.')
        if digest(pathlib.Path(api.format_abspath(book_id, fmt))) != expected:
            raise UploadReviewError(f'Checksum verification failed for {fmt} on new book {book_id}.')
        added_fmts.append(fmt)
    if cover_bytes:
        try:
            api.set_cover({book_id: cover_bytes})
        except Exception:
            pass
    api.dump_metadata([book_id])
    event(
        book_id, uuid, title,
        added=mi.tags,
        upload_applied={'id': item['id'], 'action': 'add_book', 'formats': added_fmts, 'backup': str(backup)},
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('library', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    items = read_plan(sys.stdin)

    from calibre.db.legacy import LibraryDatabase
    db = LibraryDatabase(str(args.library))
    try:
        api = db.new_api
        with tempfile.TemporaryDirectory() as tmp:
            work_dir = pathlib.Path(tmp)
            with api.write_lock:
                reviews, skipped = [], []
                for item in items:
                    calibre_id = item['target']['id'] if item['action'] == 'add_format' and item.get('target') else 0
                    title = item['target']['title'] if item['action'] == 'add_format' and item.get('target') else item.get('title', item['filename'])
                    try:
                        review = UploadReview(api, args.library, item, work_dir)
                    except UploadReviewError as error:
                        if not args.apply:
                            plan_clean = {k: v for k, v in item.items() if k != 'data_base64'}
                            event(calibre_id, None, title, upload_review={
                                'plan': plan_clean, 'action': item['action'], 'filename': item['filename'],
                                'source_format': item.get('format', ''), 'convert_to': item.get('converts_to'),
                                'add_formats': [], 'target': item.get('target'), 'blockers': [str(error)],
                            })
                            continue
                        skipped.append((item['filename'], calibre_id, title, str(error)))
                        continue
                    if not args.apply:
                        event(calibre_id, review.target_state['uuid'] if review.target_state else None, title, upload_review=review.summary())
                    elif item.get('reviewed') != review.fingerprint:
                        skipped.append((item['filename'], calibre_id, title, 'Source library or staged file changed since preview. Preview again.'))
                    elif review.blockers:
                        skipped.append((item['filename'], calibre_id, title, '; '.join(review.blockers)))
                    else:
                        reviews.append(review)

                if not args.apply:
                    return

                for filename, calibre_id, title, message in skipped:
                    event(calibre_id, None, title, upload_skipped={'filename': filename, 'message': message})

                if reviews:
                    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
                    backup = args.library / ('metadata.db.before-upload-' + stamp)
                    with sqlite3.connect(f'file:{args.library}/metadata.db?mode=ro', uri=True) as src, sqlite3.connect(backup) as dst:
                        src.backup(dst)
                    saved = backup.with_name(backup.name + '.files')
                    saved.mkdir(mode=0o700)
                    print(f'Backed up metadata.db to {backup} and target records to {saved}', flush=True)
                    for review in reviews:
                        apply_review(api, args.library, review, saved, backup)

                if skipped:
                    raise UploadReviewError(
                        f'{len(items) - len(skipped)} of {len(items)} upload(s) applied; {len(skipped)} skipped without changes: '
                        + '; '.join(f'{name}: {msg}' for name, _, _, msg in skipped)
                    )
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except UploadReviewError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
