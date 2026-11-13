#!/usr/bin/env python3
"""Exercise duplicate review/trash/restore using synthetic seeds in a NEW directory.
python3 validate-calibre-duplicates.py /mnt/Calibre/.corpus-duplicate-operator-NEW
Requires seeds/operator.pdf, seeds/operator.epub and seeds/cover.png; never uses a live library.
"""
import hashlib
import shutil
import json
import os
import pathlib
import sqlite3
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
if not root.name.startswith('.corpus-duplicate-operator-') or (root / 'library').exists():
    raise SystemExit('Use a new .corpus-duplicate-operator-* directory outside the real library.')
library = root / 'library'
web = root / 'web.db'
helper = pathlib.Path(__file__).with_name('calibre-duplicates.py')
env = {**os.environ, 'QT_QPA_PLATFORM': 'offscreen', 'CALIBRE_CONFIG_DIRECTORY': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache')}
report = {'checks': {}, 'uid': os.getuid()}


def run(cmd, payload=None, expected=0):
    r = subprocess.run(cmd, input=json.dumps(payload) if payload else None, capture_output=True, text=True, env=env)
    with (root / 'operator.log').open('a') as log:
        log.write(json.dumps(cmd) + '\n' + r.stdout + r.stderr + '\n')
    if expected is not None:
        assert r.returncode == expected, (cmd, r.returncode, r.stdout, r.stderr)
    return r


def native(code):
    file = root / 'native.py'
    file.write_text(code)
    return run(['/usr/bin/calibre-debug', '-e', str(file), '--', str(library)])


def changes(r):
    return [json.loads(line[9:]) for line in r.stdout.splitlines() if line.startswith('@@change ')]


def batch(groups, apply=False, expected=0):
    """Preview returns each group's review; apply returns the process result."""
    r = run(['/usr/bin/calibre-debug', '-e', str(helper), '--', str(library), str(web), *(['--apply'] if apply else [])], {'groups': groups}, expected)
    return r if apply else [c['duplicate_review'] for c in changes(r)]


def review(group, apply=False, expected=0):
    return batch([group], apply, expected) if apply else batch([group])[0]


try:
    report['runtime'] = run(['/usr/bin/calibre-debug', '--version']).stdout.strip()
    with sqlite3.connect(web) as db:
        db.execute('CREATE TABLE shelf(id INTEGER PRIMARY KEY,name TEXT,is_public INTEGER)')
        db.execute("INSERT INTO shelf VALUES(1,'Main',1)")
        db.execute('CREATE TABLE book_shelf_link(shelf INTEGER,book_id INTEGER)')
    for title in ['Keeper', 'Duplicate']:
        run(['/usr/bin/calibredb', 'add', '--duplicates', '--with-library', str(library), '--title', title, '--authors', 'Test Writer', *(['--cover', str(root / 'seeds/cover.png')] if title == 'Duplicate' else []), str(root / 'seeds/operator.pdf')])
    run(['/usr/bin/calibredb', 'add_format', '--with-library', str(library), '2', str(root / 'seeds/operator.epub')])
    native('''import sys,json
from calibre.db.legacy import LibraryDatabase
db=LibraryDatabase(sys.argv[1]);api=db.new_api
api.set_field('tags',{1:['keeper-tag'],2:['duplicate-tag']})
api.set_field('comments',{2:'Unique description'})
print(json.dumps([{'id':i,'uuid':api.get_metadata(i).uuid} for i in [1,2]]));db.close()
''')
    with sqlite3.connect(library / 'metadata.db') as db:
        refs = [{'id': i, 'uuid': u} for i, u in db.execute('SELECT id,uuid FROM books ORDER BY id')]
        folders = dict(db.execute('SELECT id,path FROM books'))
        pdf_name = db.execute("SELECT name FROM data WHERE book=2 AND format='PDF'").fetchone()[0]
    (library / folders[2] / (pdf_name + '.pdf')).open('ab').write(b'\n% different synthetic copy\n')
    (library / folders[2] / 'supplement.txt').write_text('Unique supplementary content')
    plan = {'keep': refs[0], 'remove': [refs[1]], 'discard_conflicts': False}
    before = review(plan)
    assert before['blockers'] and before['conflicting_formats'] == [{'format': 'PDF', 'from': 2}]
    assert before['copy_formats'] == [{'format': 'EPUB', 'from': 2}]
    report['checks']['explicitFormatConflictReview'] = True
    # Choosing to discard conflicts after the preview must not pass as the reviewed plan.
    flipped = review({**before['plan'], 'discard_conflicts': True}, True, expected=None)
    assert flipped.returncode != 0 and 'changed since preview' in flipped.stderr, flipped.stderr
    report['checks']['conflictChoiceIsPartOfReview'] = True
    plan['discard_conflicts'] = True
    preview = review(plan)
    with sqlite3.connect(web) as db:
        db.execute('INSERT INTO book_shelf_link VALUES(1,1),(1,2)')
    blocked = review({**plan, 'discard_conflicts': False})
    assert any('shelf “Main”' in item and 'Keeper 1 already belongs' in item for item in blocked['blockers'])
    assert any('conflicting formats' in item for item in blocked['blockers'])
    report['checks']['previewShowsShelfAndFormatBlockersTogether'] = True
    failed = review(preview['plan'], True, expected=None)
    assert failed.returncode != 0 and 'Calibre-Web' in failed.stderr and '0 of 1 groups resolved' in failed.stderr
    assert 'Traceback' not in failed.stderr and any('duplicate_skipped' in c for c in changes(failed))
    with sqlite3.connect(web) as db:
        db.execute('DELETE FROM book_shelf_link WHERE book_id=2')
    report['checks']['newShelfReferencePreventsApply'] = True
    native("import sys\nfrom calibre.db.legacy import LibraryDatabase\ndb=LibraryDatabase(sys.argv[1]);db.new_api.set_field('rating',{2:8});db.close()\n")
    failed = review(preview['plan'], True, expected=None)
    assert failed.returncode != 0 and 'changed since preview' in failed.stderr
    report['checks']['staleSourceReviewPreventsApply'] = True
    # A damaged unique format must block preview, before any mutation.
    with sqlite3.connect(library / 'metadata.db') as db:
        epub_name = db.execute("SELECT name FROM data WHERE book=2 AND format='EPUB'").fetchone()[0]
    epub_file = library / folders[2] / (epub_name + '.epub')
    original_epub = epub_file.read_bytes()
    epub_file.write_bytes(b'broken EPUB')
    assert any('surviving EPUB is damaged' in x for x in review(plan)['blockers'])
    epub_file.write_bytes(original_epub)
    report['checks']['damagedSurvivingFormatBlocksPreview'] = True
    preview = review(plan)
    # Fail after the native API has copied a unique format; trash must not run.
    fault = root / 'fault-copy.py'
    fault.write_text('''import sys,runpy,functools
from calibre.db.cache import Cache
original=Cache.add_format
@functools.wraps(original)
def fail(self,*args,**kwargs):
 original(self,*args,**kwargs)
 raise OSError('Injected failure after format copy')
Cache.add_format=fail
script=sys.argv[1];sys.argv=sys.argv[1:];runpy.run_path(script,run_name='__main__')
''')
    failed = run(['/usr/bin/calibre-debug','-e',str(fault),'--',str(helper),str(library),str(web),'--apply'],{'groups':[preview['plan']]},expected=None)
    assert failed.returncode != 0 and 'duplicate_partial' in failed.stdout
    assert 'Traceback' in failed.stderr and 'OSError: Injected failure after format copy' in failed.stderr
    with sqlite3.connect(library / 'metadata.db') as db:
        assert db.execute('SELECT count(*) FROM books').fetchone()[0] == 2
    report['checks']['partialCopyFailureAuditedWithoutTrash'] = True
    preview = review(plan)
    result = review(preview['plan'], True)
    assert 'duplicate_resolved' in result.stdout
    report['checks']['mergeAndTrash'] = True
    native('''import sys,pathlib
from calibre.db.legacy import LibraryDatabase
db=LibraryDatabase(sys.argv[1]);api=db.new_api
assert set(api.all_book_ids())=={1}
assert set(api.formats(1))=={'PDF','EPUB'}
assert set(api.field_for('tags',1))=={'keeper-tag','duplicate-tag'}
assert api.field_for('comments',1)=='Unique description'
assert api.field_for('cover',1)
assert (pathlib.Path(sys.argv[1])/api.field_for('path',1)/'supplement.txt').read_text()=='Unique supplementary content'
api.move_book_from_trash(2)
assert set(api.all_book_ids())=={1,2}
db.close()
''')
    report['checks']['formatsTagsMetadataCoverExtrasPreservedAndTrashRestorable'] = True
    assert len(list(library.glob('metadata.db.before-duplicates-*.files'))) == 2
    report['checks']['bothRecordBackupsRetained'] = True

    # A batch: keeper 3 with an identical copy 4 and an EPUB-only 5; keeper 6 with 7; and 8/9,
    # which changes after preview and must be skipped while the others resolve.
    for title, files in [('Batch A', ['operator.pdf']), ('Batch A', ['operator.pdf']), ('Batch A', ['operator.epub']),
                         ('Batch B', ['operator.pdf']), ('Batch B', ['operator.pdf']), ('Batch C', ['operator.pdf']), ('Batch C', ['operator.pdf'])]:
        run(['/usr/bin/calibredb', 'add', '--duplicates', '--with-library', str(library), '--title', title, '--authors', 'Test Writer', *[str(root / 'seeds' / f) for f in files]])
    native("import sys\nfrom calibre.db.legacy import LibraryDatabase\ndb=LibraryDatabase(sys.argv[1]);db.new_api.set_field('tags',{5:['from-five'],7:['from-seven']});db.close()\n")
    with sqlite3.connect(library / 'metadata.db') as db:
        ref = {i: {'id': i, 'uuid': u} for i, u in db.execute('SELECT id,uuid FROM books WHERE id>=3')}
    assert sorted(ref) == [3, 4, 5, 6, 7, 8, 9], sorted(ref)
    groups = [{'keep': ref[3], 'remove': [ref[4], ref[5]], 'discard_conflicts': False},
              {'keep': ref[6], 'remove': [ref[7]], 'discard_conflicts': False},
              {'keep': ref[8], 'remove': [ref[9]], 'discard_conflicts': False}]
    reviews = batch(groups)
    assert [r['blockers'] for r in reviews] == [[], [], []], reviews
    assert reviews[0]['copy_formats'] == [{'format': 'EPUB', 'from': 5}] and reviews[0]['conflicting_formats'] == []
    report['checks']['batchPreviewReviewsEachGroup'] = True
    native("import sys\nfrom calibre.db.legacy import LibraryDatabase\ndb=LibraryDatabase(sys.argv[1]);db.new_api.set_field('rating',{9:6});db.close()\n")
    backups = set(library.glob('metadata.db.before-duplicates-*'))
    result = batch([r['plan'] for r in reviews], True, expected=None)
    assert result.returncode == 1 and '2 of 3 groups resolved; 1 skipped' in result.stderr and 'Traceback' not in result.stderr, result.stderr
    events = changes(result)
    assert sorted(e['duplicate_resolved']['removed_id'] for e in events if 'duplicate_resolved' in e) == [4, 5, 7]
    assert [e['calibre_id'] for e in events if 'duplicate_skipped' in e] == [8]
    new_backups = set(library.glob('metadata.db.before-duplicates-*')) - backups
    assert len([b for b in new_backups if not b.name.endswith('.files')]) == 1
    saved = next(b for b in new_backups if b.name.endswith('.files'))
    assert sorted(p.name for p in saved.iterdir()) == ['3', '6'] and (saved / '3' / '5').is_dir()
    native('''import sys
from calibre.db.legacy import LibraryDatabase
db=LibraryDatabase(sys.argv[1]);api=db.new_api
assert {3,6,8,9} <= set(api.all_book_ids()) and not ({4,5,7} & set(api.all_book_ids()))
assert set(api.formats(3))=={'PDF','EPUB'}
assert set(api.field_for('tags',3))=={'from-five'} and set(api.field_for('tags',6))=={'from-seven'}
for i in (4,5,7):
    api.move_book_from_trash(i)
assert {4,5,7} <= set(api.all_book_ids())
db.close()
''')
    report['checks']['batchResolvesCleanGroupsSkipsStaleOneWithOneBackup'] = True

    # Two duplicates with different EPUBs and a keeper without one: retaining "the keeper's
    # version" cannot choose between them, so the group stays blocked either way.
    for title, seed in [('Batch D', 'operator.pdf'), ('Batch D', 'operator.epub'), ('Batch D', 'operator.epub')]:
        run(['/usr/bin/calibredb', 'add', '--duplicates', '--with-library', str(library), '--title', title, '--authors', 'Test Writer', str(root / 'seeds' / seed)])
    with sqlite3.connect(library / 'metadata.db') as db:
        d = [{'id': i, 'uuid': u} for i, u in db.execute("SELECT id,uuid FROM books WHERE title='Batch D' ORDER BY id")]
        folder, name = db.execute("SELECT b.path,d.name FROM books b JOIN data d ON d.book=b.id WHERE b.id=?", (d[2]['id'],)).fetchone()
    import zipfile as _zip
    with _zip.ZipFile(library / folder / (name + '.epub'), 'a') as archive:
        archive.writestr('OEBPS/extra.txt', 'a different copy')
    for discard in (False, True):
        blocked = review({'keep': d[0], 'remove': d[1:], 'discard_conflicts': discard})
        assert any('the keeper has none' in b for b in blocked['blockers']), blocked['blockers']
    report['checks']['conflictBetweenDuplicatesWithoutKeeperVersionBlocks'] = True
    report['scriptSha256'] = hashlib.sha256(helper.read_bytes()).hexdigest()
    report['pass'] = True
finally:
    (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
