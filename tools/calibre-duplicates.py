#!/usr/bin/env python3
"""Native Calibre duplicate review. Run with calibre-debug -e SCRIPT -- LIBRARY APP_DB [--apply].

Reads a batch plan on stdin: {"groups": [{"keep": {id, uuid}, "remove": [{id, uuid}, ...],
"discard_conflicts": bool}, ...]}. Each group keeps one record and merges the others into it before
they go to Calibre's trash. A preview prints one "@@change" review per group, with its blockers and a
fingerprint of every member's metadata and file bytes. An apply sends back the reviewed groups, backs
up metadata.db once, then resolves each group whose sources still match its review. Groups that
changed or gained blockers are skipped without any change; the exit status is then non-zero.

Calibre-Web shelf memberships are not blockers: the apply backs up Calibre-Web's app.db once, then
moves each duplicate's shelf links to its keeper (or drops them where the keeper is already on that
shelf) just before the duplicates go to the trash. Any other Calibre-Web link still blocks.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import sqlite3
import sys
import zipfile

MAX_GROUPS = 500


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


def shelf_plan(app_db, keep_id, remove_id):
    """The duplicate's shelf links and what the apply will do with each, without private shelf names."""
    plan = []
    with sqlite3.connect(f'file:{app_db}?mode=ro', uri=True) as web:
        for shelf_id, name, public in web.execute('SELECT s.id,s.name,s.is_public FROM shelf s JOIN book_shelf_link l ON l.shelf=s.id WHERE l.book_id=? ORDER BY s.id', (remove_id,)):
            present = web.execute('SELECT 1 FROM book_shelf_link WHERE shelf=? AND book_id=?', (shelf_id, keep_id)).fetchone() is not None
            plan.append({'shelf': f'“{name}”' if public else 'a private shelf', 'duplicate': remove_id, 'action': 'drop' if present else 'move'})
    return plan


def move_shelves(app_db, keep_id, remove_id):
    """In one transaction, move the duplicate's shelf links to the keeper, keeping their order and date,
    or drop a link where the keeper is already on that shelf; touch each shelf as Calibre-Web does."""
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat(sep=' ')
    web = sqlite3.connect(app_db, timeout=30, isolation_level=None)
    try:
        web.execute('BEGIN IMMEDIATE')
        try:
            done = []
            for link_id, shelf_id, name, public in web.execute('SELECT l.id,s.id,s.name,s.is_public FROM book_shelf_link l JOIN shelf s ON s.id=l.shelf WHERE l.book_id=? ORDER BY s.id', (remove_id,)).fetchall():
                if web.execute('SELECT 1 FROM book_shelf_link WHERE shelf=? AND book_id=?', (shelf_id, keep_id)).fetchone():
                    web.execute('DELETE FROM book_shelf_link WHERE id=?', (link_id,))
                    action = 'dropped'
                else:
                    web.execute('UPDATE book_shelf_link SET book_id=? WHERE id=?', (keep_id, link_id))
                    action = 'moved'
                web.execute('UPDATE shelf SET last_modified=? WHERE id=?', (now, shelf_id))
                done.append({'shelf': f'“{name}”' if public else 'a private shelf', 'action': action})
            web.execute('COMMIT')
            return done
        except BaseException:
            web.execute('ROLLBACK')
            raise
    finally:
        web.close()


def reference_blockers(library, app_db, keep_id, remove_id):
    """Read references without editing Calibre-Web. Shelf links are moved, not blockers, unless orphaned."""
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
                        # A link whose shelf is gone cannot be moved; it must be repaired first.
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
                    blockers.append(f'Duplicate {remove_id} has Calibre annotations. Preserve those before resolving this pair.')
    except sqlite3.Error:
        blockers.append('Could not inspect Calibre annotations. Restore database access before resolving this pair.')
    return blockers


def valid_ref(ref):
    return isinstance(ref, dict) and type(ref.get('id')) is int and ref['id'] >= 1 and isinstance(ref.get('uuid'), str) and ref['uuid']


def read_plan(stream):
    """Validate the batch shape before Calibre opens; every book belongs to at most one group."""
    try:
        plan = json.load(stream)
    except json.JSONDecodeError as error:
        raise DuplicateReviewError('Send a valid JSON duplicate review plan.') from error
    groups = plan.get('groups') if isinstance(plan, dict) else None
    if not isinstance(groups, list) or not groups:
        raise DuplicateReviewError('Send at least one duplicate group to review.')
    if len(groups) > MAX_GROUPS:
        raise DuplicateReviewError(f'Review at most {MAX_GROUPS} groups at a time.')
    seen_ids, seen_uuids = set(), set()
    for group in groups:
        if not isinstance(group, dict) or type(group.get('discard_conflicts')) is not bool:
            raise DuplicateReviewError('Review conflicting formats explicitly.')
        removes = group.get('remove')
        if not valid_ref(group.get('keep')) or not isinstance(removes, list) or not removes or not all(valid_ref(r) for r in removes):
            raise DuplicateReviewError('Invalid book identity.')
        if 'reviewed' in group and not isinstance(group['reviewed'], str):
            raise DuplicateReviewError('Invalid review fingerprint.')
        for ref in [group['keep'], *removes]:
            if ref['id'] in seen_ids or ref['uuid'] in seen_uuids:
                raise DuplicateReviewError('Each book may appear only once in a batch.')
            seen_ids.add(ref['id'])
            seen_uuids.add(ref['uuid'])
    return groups


class Review:
    """One group's sources, merge plan and blockers, read under Calibre's write lock."""

    def __init__(self, api, library, app_db, group):
        self.api, self.library, self.group = api, library, group
        self.keep, self.km = self.state(group['keep'])
        self.removes = [self.state(ref) for ref in group['remove']]
        blockers, self.shelves = [], []
        for remove, _ in self.removes:
            refs = reference_blockers(library, app_db, self.keep['id'], remove['id'])
            blockers += refs
            if app_db.is_file() and not refs:
                self.shelves += shelf_plan(app_db, self.keep['id'], remove['id'])
        ki = dict(self.km.identifiers)
        merged_ids, owner_of = dict(ki), {k: self.keep['id'] for k in ki}
        formats = {fmt: (self.keep['id'], info) for fmt, info in self.keep['formats'].items()}
        files = {name: (self.keep['id'], h) for name, h in self.keep['files'].items()}
        self.copy_formats, self.conflicts, self.extras = [], [], []
        for remove, rm in self.removes:
            for key, value in rm.get_all_user_metadata(make_copy=True).items():
                if value.get('#value#') not in (None, '', []) and value.get('#value#') != self.km.get(key):
                    blockers.append(f'Custom field needs manual merge: {key} (duplicate {remove["id"]})')
            for key, value in rm.identifiers.items():
                if key in merged_ids and merged_ids[key] != value:
                    blockers.append(f'Conflicting identifier needs manual review: {key} ({owner_of[key]} and {remove["id"]})')
                elif key not in merged_ids:
                    merged_ids[key], owner_of[key] = value, remove['id']
            for fmt, info in remove['formats'].items():
                if fmt not in formats:
                    formats[fmt] = (remove['id'], info)
                    self.copy_formats.append({'format': fmt, 'from': remove['id']})
                elif formats[fmt][1]['sha256'] != info['sha256']:
                    if formats[fmt][0] == self.keep['id']:
                        self.conflicts.append({'format': fmt, 'from': remove['id']})
                    else:
                        # The keeper has no version to retain, so discard_conflicts cannot settle this.
                        blockers.append(f'Duplicates {formats[fmt][0]} and {remove["id"]} have different {fmt} files and the keeper has none. '
                                        'Make the one to keep the keeper, or resolve one of them separately.')
            format_files = {v['file'] for v in remove['formats'].values()}
            for name, value in remove['files'].items():
                if name in format_files or name == 'cover.jpg':
                    continue
                if name not in files:
                    files[name] = (remove['id'], value)
                    self.extras.append({'file': name, 'from': remove['id'], 'sha256': value})
                elif files[name][1] != value:
                    blockers.append(f'Conflicting supplementary file: {name} (duplicate {remove["id"]})')
        if self.conflicts and not group['discard_conflicts']:
            blockers.append('Choose to retain the keeper’s versions of conflicting formats: ' + ', '.join(sorted({c['format'] for c in self.conflicts})))
        self.surviving = formats
        self.identifiers = merged_ids
        # Reject an unusable surviving EPUB during preview as well as apply.
        if 'EPUB' in formats:
            owner_id, info = formats['EPUB']
            owner = self.keep if owner_id == self.keep['id'] else next(r for r, _ in self.removes if r['id'] == owner_id)
            try:
                with zipfile.ZipFile(inside(library, owner['folder']) / info['file']) as archive:
                    if archive.testzip() is not None or 'META-INF/container.xml' not in archive.namelist():
                        raise ValueError('Invalid EPUB contents')
            except (ValueError, OSError, zipfile.BadZipFile) as error:
                blockers.append('A surviving EPUB is damaged. Choose a valid keeper or repair it first: ' + str(error))
        self.blockers = blockers
        # The conflict choice is part of the review: an apply cannot discard formats the preview kept.
        self.fingerprint = hashlib.sha256(json.dumps([self.keep, [r for r, _ in self.removes], group['discard_conflicts']], sort_keys=True, default=str).encode()).hexdigest()

    def state(self, ref):
        api = self.api
        if not api.has_id(ref['id']):
            raise DuplicateReviewError(f'Calibre book {ref["id"]} no longer exists. Review again.')
        mi = api.get_metadata(ref['id'])
        if mi.uuid != ref['uuid']:
            raise DuplicateReviewError(f'Calibre id {ref["id"]} belongs to a different book. Review again.')
        folder = api.field_for('path', ref['id'])
        root = inside(self.library, folder)
        files = {}
        for file in sorted(root.rglob('*')):
            if file.is_symlink():
                raise DuplicateReviewError(f'Book {ref["id"]} contains a symlink.')
            if file.is_file() and file.name != 'metadata.opf':
                files[str(file.relative_to(root))] = digest(inside(root, file.relative_to(root)))
        formats = {}
        for fmt in (api.formats(ref['id']) or ()):
            file = pathlib.Path(api.format_abspath(ref['id'], fmt))
            rel = str(file.relative_to(root))
            if rel not in files:
                raise DuplicateReviewError(f'A declared format of book {ref["id"]} is missing: {fmt}')
            formats[fmt] = {'file': rel, 'sha256': files[rel]}
        values = {k: mi.get(k) for k in ['title', 'authors', 'pubdate', 'identifiers', 'tags', 'publisher', 'comments', 'series', 'series_index', 'languages', 'rating']}
        values['custom'] = mi.get_all_user_metadata(make_copy=True)
        return {'id': ref['id'], 'uuid': mi.uuid, 'folder': folder, 'values': values, 'files': files, 'formats': formats}, mi

    def summary(self):
        return {'plan': {**self.group, 'reviewed': self.fingerprint}, 'keep': self.keep, 'remove': [r for r, _ in self.removes],
                'copy_formats': self.copy_formats, 'conflicting_formats': self.conflicts, 'shelves': self.shelves, 'blockers': self.blockers}


def event(ref, title, **fields):
    print('@@change ' + json.dumps({'calibre_id': ref['id'], 'uuid': ref['uuid'], 'title': title, **fields}, default=str), flush=True)


def resolve(api, library, app_db, review, saved, backup):
    """Merge one reviewed group into its keeper and trash the rest. Raises after any partial change."""
    keep, km = review.keep, review.km
    group_dir = saved / str(keep['id'])
    group_dir.mkdir(mode=0o700)
    for item in [keep, *(r for r, _ in review.removes)]:
        shutil.copytree(inside(library, item['folder']), group_dir / str(item['id']), symlinks=True)
        for name, expected in item['files'].items():
            if digest(inside(group_dir / str(item['id']), name)) != expected:
                raise DuplicateReviewError(f'Book {item["id"]} changed during backup; no mutation was made.')
    (group_dir / 'review.json').write_text(json.dumps(review.summary(), indent=2, default=str))
    removes = {r['id']: (r, rm) for r, rm in review.removes}
    try:
        for copy in review.copy_formats:
            fmt, remove = copy['format'], removes[copy['from']][0]
            source = inside(group_dir / str(remove['id']), remove['formats'][fmt]['file'])
            if not api.add_format(keep['id'], fmt, str(source), replace=False, run_hooks=False):
                raise DuplicateReviewError('Could not add unique format: ' + fmt)
            if digest(pathlib.Path(api.format_abspath(keep['id'], fmt))) != remove['formats'][fmt]['sha256']:
                raise DuplicateReviewError('Copied format checksum failed: ' + fmt)
            event(keep, km.title, added_format=fmt, source_format=f'duplicate {remove["id"]}')
        tags = list(km.tags or [])
        for _, rm in review.removes:
            tags += [t for t in (rm.tags or []) if t not in tags]
        if tags != list(km.tags or []):
            api.set_field('tags', {keep['id']: tags})
            event(keep, km.title, added=[t for t in tags if t not in (km.tags or [])])
        api.set_field('identifiers', {keep['id']: review.identifiers})
        for field in ['publisher', 'comments', 'series', 'languages', 'rating']:
            if km.get(field):
                continue
            donor = next((rm for _, rm in review.removes if rm.get(field)), None)
            if donor is not None:
                api.set_field(field, {keep['id']: donor.get(field)})
                if field == 'series':
                    api.set_field('series_index', {keep['id']: donor.series_index})
        destination = inside(library, api.field_for('path', keep['id']))
        for extra in review.extras:
            file = inside(destination, extra['file'])
            if not file.exists():
                file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(inside(group_dir / str(extra['from']), extra['file']), file)
            if digest(file) != extra['sha256']:
                raise DuplicateReviewError('Supplementary-file checksum failed.')
        if not api.field_for('cover', keep['id']):
            donor = next((r for r, _ in review.removes if 'cover.jpg' in r['files']), None)
            if donor is not None:
                api.set_cover({keep['id']: inside(group_dir / str(donor['id']), 'cover.jpg').read_bytes()})
        api.dump_metadata([keep['id']])
        # Verify every original keeper format and every unique copied format before deletion.
        for fmt, (_, info) in review.surviving.items():
            if digest(pathlib.Path(api.format_abspath(keep['id'], fmt))) != info['sha256']:
                raise DuplicateReviewError('Keeper format verification failed; duplicates were not trashed.')
        new_blockers = [b for r in removes for b in reference_blockers(library, app_db, keep['id'], r)]
        if new_blockers:
            raise DuplicateReviewError('; '.join(new_blockers))
        shelves = {r: move_shelves(app_db, keep['id'], r) for r in removes}
        api.remove_books(list(removes), permanent=False)
        for remove, _ in review.removes:
            event(keep, km.title, duplicate_resolved={'removed_id': remove['id'], 'removed_uuid': remove['uuid'], 'backup': str(backup), 'trash': True, 'shelves': shelves[remove['id']]})
    except Exception:
        # Preserve the original error; never claim the trash step completed.
        event(keep, km.title, duplicate_partial={'backup': str(backup), 'message': 'Resolution interrupted; inspect keeper and trash before retrying.'})
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('library', type=pathlib.Path)
    parser.add_argument('app_db', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    groups = read_plan(sys.stdin)
    from calibre.db.legacy import LibraryDatabase
    db = LibraryDatabase(str(args.library))
    try:
        api = db.new_api
        with api.write_lock:
            reviews, skipped = [], []
            for group in groups:
                keep = group['keep']
                try:
                    review = Review(api, args.library, args.app_db, group)
                except DuplicateReviewError as error:
                    if not args.apply:
                        event(keep, f'Calibre book {keep["id"]}', duplicate_review={'plan': group, 'keep': None, 'remove': [], 'copy_formats': [], 'conflicting_formats': [], 'blockers': [str(error)]})
                        continue
                    skipped.append((keep, str(error)))
                    continue
                if not args.apply:
                    event(review.keep, review.km.title, duplicate_review=review.summary())
                elif group.get('reviewed') != review.fingerprint:
                    skipped.append((keep, 'Source metadata or file bytes changed since preview. Review again.'))
                elif review.blockers:
                    skipped.append((keep, '; '.join(review.blockers)))
                else:
                    reviews.append(review)
            if not args.apply:
                return
            for keep, message in skipped:
                event(keep, f'Calibre book {keep["id"]}', duplicate_skipped={'message': message})
            if reviews:
                stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
                backup = args.library / ('metadata.db.before-duplicates-' + stamp)
                with sqlite3.connect(f'file:{args.library}/metadata.db?mode=ro', uri=True) as src, sqlite3.connect(backup) as dst:
                    src.backup(dst)
                saved = backup.with_name(backup.name + '.files')
                saved.mkdir(mode=0o700)
                # Calibre-Web's database too, since shelf links move to the keepers.
                with sqlite3.connect(f'file:{args.app_db}?mode=ro', uri=True) as src, sqlite3.connect(saved / 'app.db') as dst:
                    src.backup(dst)
                print(f'Backed up metadata.db to {backup}, Calibre-Web’s app.db and the group records to {saved}', flush=True)
                for review in reviews:
                    try:
                        resolve(api, args.library, args.app_db, review, saved, backup)
                    except DuplicateReviewError as error:
                        if not (saved / str(review.keep['id']) / 'review.json').exists():
                            # Failed during its own backup, before any change: skip only this group.
                            skipped.append((review.keep, str(error)))
                            event(review.keep, review.km.title, duplicate_skipped={'message': str(error)})
                            continue
                        raise
            if skipped:
                raise DuplicateReviewError(f'{len(groups) - len(skipped)} of {len(groups)} groups resolved; {len(skipped)} skipped without changes: '
                                           + '; '.join(f'keeper {k["id"]}: {m}' for k, m in skipped))
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except DuplicateReviewError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
