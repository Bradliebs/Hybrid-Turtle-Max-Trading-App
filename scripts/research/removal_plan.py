"""
Plan a safe removal: given root folders/files to delete, find (a) files that
become unused (imported only by deleted files), and (b) surviving files that
still import or fetch deleted code and need editing. Read-only.

Usage: python scripts/research/removal_plan.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*|require\s*\(\s*|vi\.mock\(\s*|import\s+)['"]([^'"]+)['"]""")
FETCH = re.compile(r"""['"`](/api/[A-Za-z0-9_\-/\[\]]+)""")

ROOTS = [
    'src/lib/prediction', 'src/app/api/prediction', 'src/app/prediction-status',
    'src/lib/analyst', 'src/app/api/analyst',
    'src/app/causal-audit', 'src/app/signal-audit', 'src/app/score-validation', 'src/app/filter-scorecard',
    'src/app/breakout-evidence', 'src/app/evidence', 'src/app/execution-quality', 'src/app/execution-audit',
    'src/app/trade-pulse', 'src/app/watchlist-news', 'src/app/backtest',
] + sys.argv[1:]
# Never delete these even if they look unused (entry points, config, shared types).
PROTECT = ['src/app/layout.tsx', 'src/app/page.tsx', 'src/types/', 'src/cron/', 'src/middleware.ts',
           'src/instrumentation', 'scripts/', 'packages/']


def files():
    for folder in ('src', 'packages', 'scripts'):
        for path in (ROOT / folder).rglob('*'):
            if path.suffix in ('.ts', '.tsx', '.mjs') and 'node_modules' not in path.parts:
                yield path


def resolve(spec, origin):
    if spec.startswith('@/'):
        base = ROOT / 'src' / spec[2:]
    elif spec.startswith('.'):
        base = (origin.parent / spec).resolve()
    else:
        return None
    for candidate in (base, pathlib.Path(str(base) + '.ts'), pathlib.Path(str(base) + '.tsx'), base / 'index.ts', base / 'index.tsx'):
        if candidate.is_file():
            return candidate.resolve()
    return None


def rel(path):
    return path.relative_to(ROOT).as_posix()


all_files = [p.resolve() for p in files()]
imports, fetches = {}, {}
for path in all_files:
    text = path.read_text(encoding='utf-8', errors='ignore')
    imports[path] = {t for t in (resolve(s, path) for s in IMPORT.findall(text)) if t}
    fetches[path] = set(FETCH.findall(text))

route_of = {}
for path in all_files:
    r = rel(path)
    if r.startswith('src/app/api/') and path.name == 'route.ts':
        route_of[path] = '/' + r[len('src/app/'):-len('/route.ts')]


def is_deleted_root(path):
    r = rel(path)
    return any(r == root or r.startswith(root + '/') for root in ROOTS)


deleted = {p for p in all_files if is_deleted_root(p)}
# Tests of deleted modules go too.
changed = True
while changed:
    changed = False
    importers = {p: set() for p in all_files}
    for src, targets in imports.items():
        for t in targets:
            if t in importers:
                importers[t].add(src)
    for path in all_files:
        if path in deleted or any(rel(path).startswith(x) for x in PROTECT):
            continue
        r = rel(path)
        if '.test.' in path.name:
            if imports[path] and imports[path] <= deleted | {path}:
                deleted.add(path)
                changed = True
            continue
        live_importers = {i for i in importers[path] if i not in deleted and '.test.' not in i.name}
        # Orphaned only if a deleted, non-test file used it (files used only by tests or by
        # non-code callers such as git hooks are out of scope and kept).
        was_used = any(i in deleted and '.test.' not in i.name for i in importers[path] - {path})
        # Components, hooks and lib files that were used, but now only by deleted code.
        if r.startswith(('src/components/', 'src/hooks/', 'src/lib/')) and was_used and not live_importers:
            deleted.add(path)
            changed = True
        # API routes only fetched by deleted code.
        if path in route_of:
            route = route_of[path]
            pattern = re.compile(re.escape(route).replace(r'\[', '').replace(r'\]', '') + r'(?:[/?`\'"]|$)')
            callers = [p for p in all_files if p != path and any(pattern.match(f) or f.startswith(route + '?') or f == route for f in fetches[p])]
            if callers and all(c in deleted for c in callers) and not route.startswith('/api/cron'):
                deleted.add(path)
                changed = True

survivors_needing_edit = {}
for path in all_files:
    if path in deleted:
        continue
    bad_imports = sorted(rel(t) for t in imports[path] if t in deleted)
    bad_fetches = sorted(f for f in fetches[path] if any(f.startswith(route_of[d]) for d in deleted if d in route_of)
                         or f.startswith(('/api/prediction', '/api/analyst')))
    if bad_imports or bad_fetches:
        survivors_needing_edit[rel(path)] = bad_imports + bad_fetches

total = sum(sum(1 for _ in p.open(encoding='utf-8', errors='ignore')) for p in deleted)
print(f'DELETE {len(deleted)} files, {total:,} lines')
for path in sorted(rel(p) for p in deleted):
    print('  -', path)
print(f'\nEDIT {len(survivors_needing_edit)} surviving files that reference deleted code:')
for path, refs in sorted(survivors_needing_edit.items()):
    print(f'  * {path}: {", ".join(refs)}')
