#!/usr/bin/env python3
"""Native Calibre duplicate review. Run with calibre-debug -e SCRIPT -- LIBRARY APP_DB [--apply]."""
import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import sqlite3
import sys
import zipfile


class DuplicateReviewError(Exception):
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
        raise DuplicateReviewError('Book path escapes the library or contains a symlink.')
    return p


def reference_blockers(library, app_db, keep_id, remove_id):
    """Read references without editing Calibre-Web or exposing private shelf names."""
    blockers = []
    if not app_db.is_file():
        blockers.append('Calibre-Web reference database is unavailable. Restore access before resolving this pair.')
    else:
        try:
            with sqlite3.connect(f'file:{app_db}?mode=ro', uri=True) as web:
                tables = {row[0] for row in web.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                for table in sorted(tables):
                    safe = table.replace('"', '""')
                    cols = {r[1] for r in web.execute(f'PRAGMA table_info("{safe}")')}
                    if table == 'book_shelf_link' and {'book_id', 'shelf'}.issubset(cols) and 'shelf' in tables:
                        for shelf_id, name, public in web.execute('SELECT DISTINCT s.id,s.name,s.is_public FROM shelf s JOIN book_shelf_link l ON l.shelf=s.id WHERE l.book_id=? ORDER BY s.id', (remove_id,)):
                            keeper_present = web.execute('SELECT 1 FROM book_shelf_link WHERE shelf=? AND book_id=?', (shelf_id, keep_id)).fetchone() is not None
                            label = f'shelf “{name}”' if public else 'a private shelf'
                            action = f'Keeper {keep_id} already belongs to this shelf.' if keeper_present else f'Add keeper {keep_id} to this shelf first.'
                            blockers.append(f'Calibre-Web {label} contains duplicate {remove_id}. {action} Remove only duplicate {remove_id} from that shelf in Calibre-Web, then preview again.')
                        # Broken links must still block even when the shelf row is missing.
                        if web.execute('SELECT 1 FROM book_shelf_link l LEFT JOIN shelf s ON s.id=l.shelf WHERE l.book_id=? AND s.id IS NULL LIMIT 1', (remove_id,)).fetchone():
                            blockers.append('Calibre-Web has an orphaned shelf membership for the duplicate. Repair it before resolving this pair.')
                        continue
                    for column in ['book_id', 'book']:
                        if column in cols and web.execute(f'SELECT 1 FROM "{safe}" WHERE "{column}"=? LIMIT 1', (remove_id,)).fetchone():
                            label = {'book_shelf_link': 'shelf memberships', 'bookmark': 'bookmarks', 'book_read_link': 'reading status', 'archived_book': 'archived-book links', 'downloads': 'download history'}.get(table, 'book or reading links')
                            blockers.append(f'Calibre-Web has {label} for duplicate {remove_id}. Preserve or resolve those links in Calibre-Web, then preview again.')
        except sqlite3.Error:
            blockers.append('Could not inspect Calibre-Web references. Restore database access before resolving this pair.')
    try:
        with sqlite3.connect(f'file:{library}/metadata.db?mode=ro', uri=True) as sql:
            if sql.execute("SELECT 1 FROM sqlite_master WHERE name='annotations'").fetchone():
                if sql.execute('SELECT 1 FROM annotations WHERE book=? LIMIT 1', (remove_id,)).fetchone():
                    blockers.append('The duplicate has Calibre annotations. Preserve those before resolving this pair.')
    except sqlite3.Error:
        blockers.append('Could not inspect Calibre annotations. Restore database access before resolving this pair.')
    return blockers


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('library', type=pathlib.Path)
    parser.add_argument('app_db', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        plan = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        raise DuplicateReviewError('Send a valid JSON duplicate review plan.') from error
    if not isinstance(plan, dict) or type(plan.get('discard_conflicts')) is not bool:
        raise DuplicateReviewError('Review conflicting formats explicitly.')
    for key in ['keep', 'remove']:
        ref = plan.get(key)
        if not isinstance(ref, dict) or type(ref.get('id')) is not int or ref['id'] < 1 or not isinstance(ref.get('uuid'), str):
            raise DuplicateReviewError('Invalid book identity.')
    if plan['keep']['id'] == plan['remove']['id'] or plan['keep']['uuid'] == plan['remove']['uuid']:
        raise DuplicateReviewError('Choose two different books.')
    from calibre.db.legacy import LibraryDatabase
    db = LibraryDatabase(str(args.library))
    try:
        api = db.new_api
        with api.write_lock:
            def state(ref):
                mi = api.get_metadata(ref['id'])
                if mi.uuid != ref['uuid']:
                    raise DuplicateReviewError('A Calibre id belongs to a different book. Review again.')
                folder = api.field_for('path', ref['id'])
                root = inside(args.library, folder)
                files = {}
                for file in sorted(root.rglob('*')):
                    if file.is_symlink():
                        raise DuplicateReviewError('Book contains a symlink.')
                    if file.is_file() and file.name != 'metadata.opf':
                        files[str(file.relative_to(root))] = digest(inside(root, file.relative_to(root)))
                formats = {}
                for fmt in (api.formats(ref['id']) or ()):
                    file = pathlib.Path(api.format_abspath(ref['id'], fmt))
                    rel = str(file.relative_to(root))
                    if rel not in files:
                        raise DuplicateReviewError('A declared book format is missing.')
                    formats[fmt] = {'file': rel, 'sha256': files[rel]}
                values = {k: mi.get(k) for k in ['title', 'authors', 'pubdate', 'identifiers', 'tags', 'publisher', 'comments', 'series', 'series_index', 'languages', 'rating']}
                values['custom'] = mi.get_all_user_metadata(make_copy=True)
                return {'id': ref['id'], 'uuid': mi.uuid, 'folder': folder, 'values': values, 'files': files, 'formats': formats}, mi
            keep, km = state(plan['keep'])
            remove, rm = state(plan['remove'])
            blockers = reference_blockers(args.library, args.app_db, keep['id'], remove['id'])
            for key, value in rm.get_all_user_metadata(make_copy=True).items():
                if value.get('#value#') not in (None, '', []) and value.get('#value#') != km.get(key):
                    blockers.append('Custom field needs manual merge: ' + key)
            conflicts = [fmt for fmt in remove['formats'] if fmt in keep['formats'] and remove['formats'][fmt]['sha256'] != keep['formats'][fmt]['sha256']]
            if conflicts and not plan['discard_conflicts']:
                blockers.append('Choose to retain the keeper’s versions of conflicting formats: ' + ', '.join(conflicts))
            ki, ri = km.identifiers, rm.identifiers
            for key, value in ri.items():
                if key in ki and ki[key] != value:
                    blockers.append('Conflicting identifier needs manual review: ' + key)
            format_names = {v['file'] for v in remove['formats'].values()}
            extras = {n: h for n, h in remove['files'].items() if n not in format_names and n != 'cover.jpg'}
            for name, value in extras.items():
                if name in keep['files'] and keep['files'][name] != value:
                    blockers.append('Conflicting supplementary file: ' + name)
            # Reject an unusable surviving EPUB during preview as well as apply.
            for fmt, info in {**remove['formats'], **keep['formats']}.items():
                if fmt == 'EPUB':
                    owner = keep if fmt in keep['formats'] else remove
                    try:
                        with zipfile.ZipFile(inside(args.library, owner['folder']) / info['file']) as archive:
                            if archive.testzip() is not None or 'META-INF/container.xml' not in archive.namelist():
                                raise ValueError('Invalid EPUB contents')
                    except (ValueError, OSError, zipfile.BadZipFile) as error:
                        blockers.append('A surviving EPUB is damaged. Choose a valid keeper or repair it first: ' + str(error))
            fingerprint = hashlib.sha256(json.dumps([keep, remove], sort_keys=True, default=str).encode()).hexdigest()
            review = {**plan, 'reviewed': fingerprint}
            summary = {'plan': review, 'keep': keep, 'remove': remove, 'copy_formats': sorted(set(remove['formats']) - set(keep['formats'])), 'conflicting_formats': conflicts, 'blockers': blockers}
            if not args.apply:
                print('@@change ' + json.dumps({'calibre_id': keep['id'], 'uuid': keep['uuid'], 'title': km.title, 'duplicate_review': summary}, default=str))
                return
            if plan.get('reviewed') != fingerprint:
                raise DuplicateReviewError('Source metadata or file bytes changed since preview. Review again.')
            if blockers:
                raise DuplicateReviewError('; '.join(blockers))
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
            backup = args.library / ('metadata.db.before-duplicates-' + stamp)
            with sqlite3.connect(f'file:{args.library}/metadata.db?mode=ro', uri=True) as src, sqlite3.connect(backup) as dst:
                src.backup(dst)
            saved = backup.with_name(backup.name + '.files')
            saved.mkdir(mode=0o700)
            for item in [keep, remove]:
                shutil.copytree(inside(args.library, item['folder']), saved / str(item['id']), symlinks=True)
                for name, expected in item['files'].items():
                    file = inside(saved / str(item['id']), name)
                    if digest(file) != expected:
                        raise DuplicateReviewError('Book changed during backup; no mutation was made.')
            (saved / 'review.json').write_text(json.dumps(summary, indent=2, default=str))
            print(f'Backed up both records to {backup} and {saved}', flush=True)
            def event(**fields):
                print('@@change ' + json.dumps({'calibre_id': keep['id'], 'uuid': keep['uuid'], 'title': km.title, **fields}), flush=True)
            try:
                for fmt in summary['copy_formats']:
                    source = inside(saved / str(remove['id']), remove['formats'][fmt]['file'])
                    if not api.add_format(keep['id'], fmt, str(source), replace=False, run_hooks=False):
                        raise DuplicateReviewError('Could not add unique format: ' + fmt)
                    if digest(pathlib.Path(api.format_abspath(keep['id'], fmt))) != remove['formats'][fmt]['sha256']:
                        raise DuplicateReviewError('Copied format checksum failed: ' + fmt)
                    event(added_format=fmt, source_format='duplicate')
                tags = list(dict.fromkeys((km.tags or []) + (rm.tags or [])))
                if tags != km.tags:
                    api.set_field('tags', {keep['id']: tags})
                    event(added=[t for t in tags if t not in km.tags])
                api.set_field('identifiers', {keep['id']: {**ri, **ki}})
                for field in ['publisher', 'comments', 'series', 'languages', 'rating']:
                    if not km.get(field) and rm.get(field):
                        api.set_field(field, {keep['id']: rm.get(field)})
                        if field == 'series':
                            api.set_field('series_index', {keep['id']: rm.series_index})
                destination = inside(args.library, api.field_for('path', keep['id']))
                for name, expected in extras.items():
                    file = inside(destination, name)
                    if not file.exists():
                        file.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(inside(saved / str(remove['id']), name), file)
                    if digest(file) != expected:
                        raise DuplicateReviewError('Supplementary-file checksum failed.')
                if not api.field_for('cover', keep['id']) and 'cover.jpg' in remove['files']:
                    api.set_cover({keep['id']: inside(saved / str(remove['id']), 'cover.jpg').read_bytes()})
                api.dump_metadata([keep['id']])
                # Verify every original keeper format and every unique copied format before deletion.
                for fmt, info in {**remove['formats'], **keep['formats']}.items():
                    if digest(pathlib.Path(api.format_abspath(keep['id'], fmt))) != info['sha256']:
                        raise DuplicateReviewError('Keeper format verification failed; duplicate was not trashed.')
                new_blockers = reference_blockers(args.library, args.app_db, keep['id'], remove['id'])
                if new_blockers:
                    raise DuplicateReviewError('; '.join(new_blockers))
                api.remove_books([remove['id']], permanent=False)
                event(duplicate_resolved={'removed_id': remove['id'], 'removed_uuid': remove['uuid'], 'backup': str(backup), 'trash': True})
            except Exception:
                # Preserve the original error; never claim the trash step completed.
                print('@@change ' + json.dumps({'calibre_id': keep['id'], 'uuid': keep['uuid'], 'title': km.title,
                    'duplicate_partial': {'backup': str(backup), 'message': 'Resolution interrupted; inspect keeper and trash before retrying.'}}), flush=True)
                raise
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except DuplicateReviewError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
