"""
Read-only import map: which source files the trading jobs can reach.

Starts from the scheduled-job entry points that buy, sell, protect or sync
(src/cron/*.ts used by the Windows tasks) and follows static and dynamic
imports through src/ and packages/. Prints what the trading path reaches and
what only the dashboard reaches. Heuristic (regex imports, '@/' alias), so
treat "not reached" as "probably safe to remove", to be confirmed per item.

Usage: python scripts/research/trading_path_inventory.py
"""
import pathlib
import re
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
TRADING_ENTRIES = ['src/cron/auto-trade.ts', 'src/cron/nightly.ts', 'src/cron/midday-sync.ts',
                   'src/cron/watchdog.ts', 'src/cron/research-refresh.ts']
IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]""")


def resolve(spec, origin):
    if spec.startswith('@/'):
        base = ROOT / 'src' / spec[2:]
    elif spec.startswith('.'):
        base = (origin.parent / spec).resolve()
    else:
        return None
    for candidate in (base, base.with_suffix('.ts'), base.with_suffix('.tsx'), base / 'index.ts', base / 'index.tsx'):
        if candidate.is_file():
            return candidate
    for suffix in ('.ts', '.tsx'):
        candidate = pathlib.Path(str(base) + suffix)
        if candidate.is_file():
            return candidate
    return None


def reach(entries):
    seen, stack = set(), [ROOT / e for e in entries if (ROOT / e).is_file()]
    while stack:
        path = stack.pop()
        if path in seen:
            continue
        seen.add(path)
        for spec in IMPORT.findall(path.read_text(encoding='utf-8', errors='ignore')):
            target = resolve(spec, path)
            if target and target not in seen:
                stack.append(target)
    return seen


def source_files():
    for folder in ('src', 'packages'):
        for path in (ROOT / folder).rglob('*'):
            if path.suffix in ('.ts', '.tsx') and '.test.' not in path.name and 'node_modules' not in path.parts:
                yield path


trading = reach(TRADING_ENTRIES)
everything = list(source_files())
lines = {p: sum(1 for _ in p.open(encoding='utf-8', errors='ignore')) for p in everything}
off_path = [p for p in everything if p not in trading]


def group(path):
    rel = path.relative_to(ROOT).as_posix()
    parts = rel.split('/')
    if parts[0] == 'packages':
        return '/'.join(parts[:2])
    if parts[1] == 'app':
        return 'src/app/api/' + parts[3] if len(parts) > 3 and parts[2] == 'api' else 'src/app/' + (parts[2] if len(parts) > 3 else '(root)')
    if parts[1] == 'lib' and len(parts) > 3:
        return 'src/lib/' + parts[2]
    return '/'.join(parts[:2])


print(f'Files: {len(everything)} ({sum(lines.values()):,} lines). '
      f'Reached by trading jobs: {len(trading & set(everything))} '
      f'({sum(lines[p] for p in everything if p in trading):,} lines).')
print('\nLibrary modules the trading jobs use (src/lib, top level):')
print('  ' + ', '.join(sorted(p.stem for p in trading if p.parent == ROOT / 'src' / 'lib')))
print('\nNot reached by any trading job, by area (files, lines):')
counts, sizes = Counter(), Counter()
for path in off_path:
    counts[group(path)] += 1
    sizes[group(path)] += lines[path]
for name, size in sorted(sizes.items(), key=lambda item: -item[1])[:45]:
    print(f'  {name:<45} {counts[name]:>4} files {size:>7,} lines')
lib_off = sorted(p.stem for p in off_path if p.parent == ROOT / 'src' / 'lib')
print(f'\nTop-level src/lib modules not used by trading ({len(lib_off)}):')
print('  ' + ', '.join(lib_off))
