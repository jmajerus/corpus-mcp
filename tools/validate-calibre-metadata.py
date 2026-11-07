#!/usr/bin/env python3
"""Operator exercise: a NEW, disposable library; never point this at a real library.

python3 validate-calibre-metadata.py NEW_TEST_ROOT
Place operator.pdf, operator.epub and cover.png in NEW_TEST_ROOT/seeds first.
Run as the production library owner, on the same filesystem and Calibre runtime.
"""
import copy
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
if not root.name.startswith('.corpus-metadata-operator-') or (root / 'library').exists():
    raise SystemExit('Use a new .corpus-metadata-operator-* directory, outside the real library.')
library = root / 'library'
helper = pathlib.Path(__file__).with_name('calibre-metadata.py').resolve()
recover = pathlib.Path(__file__).with_name('calibre-metadata-recover.py').resolve()
env = {**os.environ, 'QT_QPA_PLATFORM': 'offscreen', 'CALIBRE_CONFIG_DIRECTORY': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache')}
report = {'started': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(), 'uid': os.getuid(), 'library': str(library), 'checks': {}}
logfile = root / 'operator.log'


def run(command, payload=None, expected=0, environ=env):
    result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None, env=environ, capture_output=True, text=True)
    with logfile.open('a') as log:
        log.write(json.dumps(command) + '\n' + result.stdout + result.stderr + '\n')
    if expected is not None:
        assert result.returncode == expected, (command, result.returncode, result.stdout, result.stderr)
    return result


def digest(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def state(book_id):
    with sqlite3.connect(library / 'metadata.db') as db:
        db.row_factory = sqlite3.Row
        book = dict(db.execute('SELECT id,uuid,title,pubdate,sort,author_sort,path FROM books WHERE id=?', (book_id,)).fetchone())
        authors = [r[0] for r in db.execute('SELECT a.name FROM books_authors_link l JOIN authors a ON a.id=l.author WHERE l.book=? ORDER BY l.id', (book_id,))]
        row = db.execute('SELECT text FROM comments WHERE book=?', (book_id,)).fetchone()
        comments = row[0] if row else None
        formats = {fmt: {'path': str(library / book['path'] / f'{name}.{fmt.lower()}'), 'hash': digest(library / book['path'] / f'{name}.{fmt.lower()}')} for fmt, name in db.execute('SELECT format,name FROM data WHERE book=?', (book_id,))}
    year = int(book['pubdate'][:4]) if book['pubdate'] else 0
    return {'book': book, 'authors': authors, 'values': {'title': book['title'], 'authors': authors, 'year': year if year > 1000 else None}, 'formats': formats, 'comments': comments, 'cover': digest(library / book['path'] / 'cover.jpg') if (library / book['path'] / 'cover.jpg').exists() else None, 'extra': digest(library / book['path'] / 'supplement.txt') if (library / book['path'] / 'supplement.txt').exists() else None}


def latest_backup():
    return sorted(p for p in library.glob('metadata.db.before-metadata-*') if p.is_file())[-1]


def apply(plan, **kwargs):
    return run(['python3', str(helper), '--apply', str(library)], plan, **kwargs)


try:
    report['runtime'] = run(['/usr/bin/calibre-debug', '--version']).stdout.strip()
    run(['/usr/bin/calibredb', 'add', '--with-library', str(library), '--title', 'Original Operator Book', '--authors', 'Original Writer', '--cover', str(root / 'seeds/cover.png'), str(root / 'seeds/operator.pdf')])
    with sqlite3.connect(library / 'metadata.db') as db:
        target = db.execute('SELECT id FROM books').fetchone()[0]
    run(['/usr/bin/calibredb', 'add_format', '--with-library', str(library), str(target), str(root / 'seeds/operator.epub')])
    run(['/usr/bin/calibredb', 'add', '--with-library', str(library), '--title', 'Unrelated Operator Book', '--authors', 'Another Writer', str(root / 'seeds/operator.pdf')])
    (root / 'setup.py').write_text('''import sys,datetime
from calibre.db.legacy import LibraryDatabase
db=LibraryDatabase(sys.argv[1]);api=db.new_api
api.set_field('pubdate',{int(sys.argv[2]):datetime.datetime(2017,5,17,12,34,56,tzinfo=datetime.timezone.utc)})
api.set_field('sort',{int(sys.argv[2]):'Custom title sort'})
api.set_field('author_sort',{int(sys.argv[2]):'Custom author sort'})
api.dump_metadata(api.all_book_ids());db.close()
''')
    run(['/usr/bin/calibre-debug', '-e', str(root / 'setup.py'), '--', str(library), str(target)])
    initial = state(target)
    (library / initial['book']['path'] / 'supplement.txt').write_text('Synthetic supplementary data, retained during rename and recovery.\n')
    initial = state(target)
    other_id = target + 1
    other = state(other_id)
    plan = {'books': [{'calibre_id': target, 'uuid': initial['book']['uuid'], 'title': initial['book']['title'], 'before': initial['values'], 'after': {'title': 'The Revised Operator Book', 'authors': ['Zoë Writer', 'William Strunk, Jr.'], 'year': 2024}}]}
    apply(plan)
    edited = state(target)
    assert edited['values'] == {**plan['books'][0]['after'], 'authors': ['Zoë Writer', 'William Strunk| Jr.']}
    assert edited['book']['path'] != initial['book']['path']
    assert {k: v['hash'] for k, v in edited['formats'].items()} == {k: v['hash'] for k, v in initial['formats'].items()}
    assert edited['cover'] == initial['cover'] and edited['extra'] == initial['extra']
    report['checks']['realFormatsCoverExtraAndRename'] = True
    backup = latest_backup()
    run(['/usr/bin/calibre-debug', '-e', str(recover), '--', str(library), str(backup)])
    assert state(target) == edited
    run(['/usr/bin/calibre-debug', '-e', str(recover), '--', str(library), str(backup), '--apply'])
    assert state(target) == initial
    report['checks']['successfulWriteRecoveryIncludingDateSortAndPaths'] = True

    for kind in ['stale', 'reused-id', 'missing-runtime']:
        invalid = copy.deepcopy(plan)
        opts = {}
        if kind == 'stale': invalid['books'][0]['before']['title'] = 'Stale title'
        if kind == 'reused-id': invalid['books'][0]['uuid'] = 'wrong-uuid'
        if kind == 'missing-runtime': opts['environ'] = {**env, 'CALIBRE_BIN': str(root / 'absent')}
        result = apply(invalid, expected=None, **opts)
        assert result.returncode != 0
        assert state(target) == initial
        report['checks'][kind] = True

    # Only this fixture's Calibre process is faulted. The production writer has no failure switch.
    (root / 'fault.py').write_text('''import sys,runpy,functools
from calibre.db.cache import Cache
original=Cache.set_field
@functools.wraps(original)
def fault(self,name,*args,**kwargs):
 result=original(self,name,*args,**kwargs)
 if name=='title':raise OSError('Injected operator-test failure after title rename')
 return result
Cache.set_field=fault
args=sys.argv[1:];script=args[args.index('-e')+1];sys.argv=[script,*args[args.index('--')+1:]]
runpy.run_path(script,run_name='__main__')
''')
    (root / 'fault-bin').mkdir()
    wrapper = root / 'fault-bin/calibre-debug'
    wrapper.write_text('#!/bin/sh\nexec /usr/bin/calibre-debug -e ' + __import__('shlex').quote(str(root / 'fault.py')) + ' -- "$@"\n')
    wrapper.chmod(0o755)
    failed = apply(plan, expected=None, environ={**env, 'CALIBRE_BIN': str(root / 'fault-bin')})
    assert failed.returncode != 0
    event = json.loads(next(line[9:] for line in failed.stdout.splitlines() if line.startswith('@@change ')))
    assert event['metadata']['partial'] is True
    partial = state(target)
    assert partial['book']['title'] == plan['books'][0]['after']['title'] and partial['book']['path'] != initial['book']['path']
    assert partial['authors'] == initial['authors']
    report['checks']['failureAfterFilesystemRenameIsAudited'] = True
    backup = latest_backup()
    # Prove why copying only metadata.db is not a usable rollback after a rename.
    demo = root / 'database-only-restore'
    shutil.copytree(library, demo, ignore=shutil.ignore_patterns('metadata.db.before-metadata-*'))
    shutil.copy2(backup, demo / 'metadata.db')
    with sqlite3.connect(demo / 'metadata.db') as db:
        old_path = db.execute('SELECT path FROM books WHERE id=?', (target,)).fetchone()[0]
        fmt, name = db.execute('SELECT format,name FROM data WHERE book=? LIMIT 1', (target,)).fetchone()
        assert not (demo / old_path / f'{name}.{fmt.lower()}').exists()
    report['checks']['databaseOnlyRestoreDemonstrablyInsufficient'] = True

    manifest_path = backup.with_name(backup.name + '.files') / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    # Every malformed inventory must fail before any metadata or content writes.
    for kind in ['omitted-format', 'omitted-extra', 'wrong-formats', 'wrong-folder', 'missing-snapshot-file', 'unlisted-snapshot-file', 'missing-indexed-format']:
        altered = copy.deepcopy(manifest)
        pdf = next(name for name in manifest['files'] if name.endswith('.pdf'))
        extra = manifest_path.parent / 'book/supplement.txt'
        pdf_file = manifest_path.parent / 'book' / pdf
        unexpected = manifest_path.parent / 'book/unlisted.txt'
        if kind == 'omitted-format': del altered['files'][pdf]
        if kind == 'omitted-extra': del altered['files']['supplement.txt']
        if kind == 'wrong-formats': altered['formats'] = []
        if kind == 'wrong-folder': altered['folder'] = 'wrong-folder'
        if kind == 'missing-snapshot-file': extra.rename(manifest_path.parent / 'held-extra')
        if kind == 'unlisted-snapshot-file': unexpected.write_text('unexpected')
        if kind == 'missing-indexed-format':
            del altered['files'][pdf]
            pdf_file.rename(manifest_path.parent / 'held-pdf')
        manifest_path.write_text(json.dumps(altered))
        rejected = run(['/usr/bin/calibre-debug', '-e', str(recover), '--', str(library), str(backup), '--apply'], expected=None)
        assert rejected.returncode != 0 and state(target) == partial, kind
        manifest_path.write_text(json.dumps(manifest))
        if kind == 'missing-snapshot-file': (manifest_path.parent / 'held-extra').rename(extra)
        if kind == 'unlisted-snapshot-file': unexpected.unlink()
        if kind == 'missing-indexed-format': (manifest_path.parent / 'held-pdf').rename(pdf_file)
    report['checks']['incompleteInventoriesRefusedBeforeWrites'] = True
    first = next(name for name in manifest['files'] if name.endswith('.pdf'))
    saved_file = manifest_path.parent / 'book' / first
    original_bytes = saved_file.read_bytes()
    saved_file.write_bytes(b'corrupted fixture backup')
    rejected = run(['/usr/bin/calibre-debug', '-e', str(recover), '--', str(library), str(backup), '--apply'], expected=None)
    assert rejected.returncode != 0 and state(target) == partial
    saved_file.write_bytes(original_bytes)
    report['checks']['damagedBackupRefusedBeforeRecoveryWrites'] = True
    run(['/usr/bin/calibredb', 'set_metadata', '--with-library', str(library), '--field', 'comments:A later edit to an unrelated book must survive recovery.', str(other_id)])
    later_other = state(other_id)
    assert later_other['comments'] != other['comments']
    pathlib.Path(partial['formats']['PDF']['path']).unlink()
    # Simulate a runtime returning a different folder after the last metadata setter.
    # A missing PDF proves the guard runs before backup formats are restored.
    (root / 'wrong-path.py').write_text('''import sys,runpy,functools
from calibre.db.cache import Cache
original_set=Cache.set_field
original_get=Cache.field_for
changed=False
@functools.wraps(original_set)
def setter(self,name,*args,**kwargs):
 global changed
 result=original_set(self,name,*args,**kwargs)
 if name=='author_sort':changed=True
 return result
@functools.wraps(original_get)
def getter(self,name,*args,**kwargs):
 if changed and name=='path':return 'unexpected-folder'
 return original_get(self,name,*args,**kwargs)
Cache.set_field=setter;Cache.field_for=getter
script=sys.argv[1];sys.argv=sys.argv[1:];runpy.run_path(script,run_name='__main__')
''')
    rejected = run(['/usr/bin/calibre-debug', '-e', str(root / 'wrong-path.py'), '--', str(recover), str(library), str(backup), '--apply'], expected=None)
    assert rejected.returncode != 0 and 'Calibre restored a different folder' in rejected.stderr
    assert '"recovered": true' not in rejected.stdout
    restored_pdf = library / initial['book']['path'] / pathlib.Path(initial['formats']['PDF']['path']).name
    assert not restored_pdf.exists()
    report['checks']['wrongRestoredPathRefusedBeforeFileRestoration'] = True
    run(['/usr/bin/calibre-debug', '-e', str(recover), '--', str(library), str(backup), '--apply'])
    assert state(target) == initial
    assert state(other_id) == later_other
    report['checks']['partialWriteRecoveryAndMissingFormatRestoration'] = True
    report['checks']['unrelatedLaterEditPreserved'] = True
    report['pass'] = True
except Exception as error:
    report['pass'] = False
    report['error'] = str(error)
    raise
finally:
    (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
