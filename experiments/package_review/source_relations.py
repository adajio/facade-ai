"""Content-based routing hints for revision-bound source units. No inferred facts or applicability."""

import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from itertools import combinations


TOKEN = re.compile(r"[^\W_]+(?:[./_\-][^\W_]+)*\*?", re.UNICODE)
LETTER = re.compile(r"[^\W\d_]")
CAD_PREFIX = re.compile(r"^\s*\S+:h[\da-f]+\s+\S+\s+", re.I)


def _features(lines):
    codes, aligned, phrases = defaultdict(list), defaultdict(set), set()
    for i, line in enumerate(lines):
        line = CAD_PREFIX.sub("", line)
        tokens = list(TOKEN.finditer(line))
        words = [m[0].casefold() for m in tokens if len(m[0]) > 3 and m[0].isalpha()]
        phrases.update(zip(words, words[1:]))
        for match in tokens:
            text = match[0]
            if len(text) > 45 or not LETTER.search(text) or not any(c.isdigit() for c in text):
                continue
            if not text[0].isalpha():
                continue
            key = text.casefold()
            codes[key].append((i, match.start()))
            # Leading fields and cells separated by the native layout are useful across formats.
            if not line[:match.start()].strip() or line[max(0, match.start()-2):match.start()] == "  ":
                aligned[match.start() // 6].add(key)
    fields = set().union(*(v for v in aligned.values() if len(v) >= 3)) if aligned else set()
    return codes, fields, phrases


def source_signals(units, owners):
    """Rank alternatives within each distinct original pair; keep all qualifying edges inspectable."""
    features = {u: _features(lines) for u, lines in units.items()}
    df = Counter(key for codes, _, _ in features.values() for key in codes)
    pf = Counter(key for _, _, phrases in features.values() for key in phrases)
    n = max(len(units), 1)
    groups = defaultdict(list)
    for a, b in combinations(sorted(units), 2):
        if owners[a] == owners[b]:
            continue
        ca, fa, pa = features[a]
        cb, fb, pb = features[b]
        ids = sorted(ca.keys() & cb.keys(), key=lambda k: (df[k], k))
        fields = sorted(fa & fb, key=lambda k: (df[k], k))
        phrases = sorted((k for k in pa & pb if pf[k] <= max(2, n // 3)), key=lambda k: (pf[k], k))
        # One common label or a repeated project header is only a navigation hint.
        if not (len(ids) >= 3 or (len(ids) >= 1 and len(phrases) >= 3) or len(phrases) >= 8):
            continue
        score = sum(math.log1p(n / df[k]) for k in ids[:30])
        score += sum(2 * math.log1p(n / df[k]) for k in fields[:24])
        score += sum(0.45 * math.log1p(n / pf[k]) for k in phrases[:16])
        edge = {"left": a, "right": b, "score": round(score, 5), "labels": ids[:30],
                "aligned_labels": fields[:24], "phrases": [" ".join(k) for k in phrases[:10]]}
        groups[tuple(sorted([owners[a], owners[b]]))].append(edge)
    return [sorted(edges, key=lambda e: (-e["score"], e["left"], e["right"]))
            for _, edges in sorted(groups.items())]


def family_key(text):
    match = re.fullmatch(r"([^\W\d_]+[-_]?\d+)(?:[./_-][\w]+)*\*?", text, re.I)
    return (match[1] if match else text).casefold()


def asymmetric_families(left, right):
    """Matching names suggest items to check; they do not establish common scope or missing items."""
    def groups(lines):
        codes, _, _ = _features(lines)
        result = defaultdict(set)
        for key in codes:
            result[family_key(key)].add(key)
        return result
    a, b = groups(left), groups(right)
    return [{"family": key, "left": sorted(a[key]), "right": sorted(b[key])}
            for key in sorted(a.keys() & b.keys()) if a[key] != b[key]]


def revision_of(inputs):
    return hashlib.sha256(json.dumps(sorted(inputs.items()), ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def unexamined_pairs(units, owners, groups):
    """Expose original pairs outside structural discovery, including documents with no labels."""
    covered = {tuple(sorted((owners[row["left"]], owners[row["right"]])))
               for group in groups for row in group}
    by_original = defaultdict(list)
    for unit in sorted(units):
        by_original[owners[unit]].append(unit)
    return [{"originals": [a, b], "units": [by_original[a], by_original[b]],
             "state": "requires_semantic_survey"}
            for a, b in combinations(sorted(by_original), 2) if (a, b) not in covered]
