"""Plan all original reading windows and admit only actually located model observations."""

import re
from collections import defaultdict, deque

from .intake_checks import compact_line
from .source_relations import TOKEN, family_key, source_signals


def reading_jobs(units, owners, width=7500):
    groups = source_signals(units, owners)
    scores = defaultdict(float)
    for group in groups:
        best = max(1, group[0]["score"])
        for edge in group:
            for ref in (edge["left"], edge["right"]):
                # Reward a strong representative of each original pair as well as aligned fields.
                scores[ref] = max(
                    scores[ref],
                    (edge["score"] / best)
                    * (4 + len(edge["aligned_labels"]) + len(edge["labels"]) / 5),
                )
    jobs = []
    for ref, lines in units.items():
        current, size = [], 0
        for i, line in enumerate(lines):
            value = compact_line(line)
            if size + len(value) > width and current:
                jobs.append((scores[ref], ref, current))
                current, size = [], 0
            current.append([i, value])
            size += len(value) + 10
        if current or not lines:
            jobs.append((scores[ref], ref, current))
    # Give every original an opening before taking another window from one
    # densely annotated drawing. Within an original preserve structural rank.
    by_original = defaultdict(deque)
    for job in sorted(jobs, key=lambda j: (-j[0], j[1], j[2][0][0] if j[2] else 0)):
        by_original[owners[job[1]]].append(job)
    active = deque(by_original.values())
    ordered = []
    while active:
        windows = active.popleft()
        ordered.append(windows.popleft())
        if windows:
            active.append(windows)
    return ordered


def located_observation(item, lines):
    if not isinstance(item, list) or len(item) != 4:
        return None
    label, indices, role, statement = item
    if (
        not isinstance(label, str)
        or not label.strip()
        or not isinstance(indices, list)
        or not indices
        or any(type(i) is not int or i not in lines for i in indices)
        or role not in ("data", "mention")
        or not isinstance(statement, str)
        or not statement.strip()
    ):
        return None
    label = label.strip()
    pattern = r"(?<!\w)" + re.escape(label) + r"(?![\w*])"
    # Remove the reader's horizontal positions before matching the original label.
    matched = (
        any(
            t[0].casefold() == label.casefold()
            for i in indices
            for t in TOKEN.finditer(lines[i])
        )
        if TOKEN.fullmatch(label)
        else any(re.search(pattern, lines[i], re.IGNORECASE) for i in indices)
    )
    if not matched:
        return None
    topic = family_key(label) if TOKEN.fullmatch(label) else label.casefold()
    return {
        "label": label,
        "topic": topic,
        "lines": sorted(set(indices)),
        "role": role,
        "text": statement,
    }


def admit_source_item(item, original_lines, presented_lines):
    """Accept an exact echoed row address or a separately anchored leading object code.

    A multi-field label copied across rows is kept verbatim as model text. It can
    identify a candidate only if its leading code is a physical first field and
    sufficient details of the description are grounded in the cited rows.
    """
    if not isinstance(item, list) or len(item) != 4 or not isinstance(item[1], list):
        return None
    label, refs, role, statement = item
    indices = []
    echoed = False
    excerpt = False
    for ref in refs:
        if type(ref) is int:
            indices.append(ref)
        elif (
            isinstance(ref, list)
            and len(ref) == 2
            and type(ref[0]) is int
            and isinstance(ref[1], str)
            and ref[0] in presented_lines
            and (
                ref[1] == presented_lines[ref[0]]
                or (
                    re.match(r"^\[\d+\]\S", ref[1])
                    and re.search(
                        r"(?:^| )" + re.escape(ref[1]) + r"(?=$| \[\d+\])",
                        presented_lines[ref[0]],
                    )
                )
            )
        ):
            excerpt = excerpt or ref[1] != presented_lines[ref[0]]
            echoed = True
            indices.append(ref[0])
        else:
            return None
    if not indices or any(
        i not in original_lines or i not in presented_lines for i in indices
    ):
        return None
    observation = located_observation([label, indices, role, statement], original_lines)
    if observation is None and isinstance(label, str) and len(label.split()) > 1:
        first = label.split()[0]
        if not (
            TOKEN.fullmatch(first)
            and any(c.isalpha() for c in first)
            and any(c.isdigit() for c in first)
        ):
            return None
        if not any(original_lines[i].lstrip().split()[:1] == [first] for i in indices):
            return None
        # Test secondary source tokens across physical cells; keep any semantic
        # attribution provisional, including the count associated with the code.
        tail_words = set(re.findall(r"[^\W_]{3,}", label[len(first) :].casefold()))
        source_words = set(
            re.findall(
                r"[^\W_]{3,}", " ".join(original_lines[i] for i in indices).casefold()
            )
        )
        if len(tail_words & source_words) < 2:
            return None
        observation = located_observation(
            [first, indices, role, statement], original_lines
        )
        if observation:
            observation.update(model_label=label, anchor_mode="leading_source_field")
    if observation and echoed:
        observation["address_mode"] = "exact_cells" if excerpt else "exact_echo"
    return observation


def source_response(content, receipt, finish_reason):
    """Decode complete JSONL items. A provider length stop always requires more reading."""
    import json

    facts, rejected = [], []
    parsed = False
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("```"):
            continue
        try:
            item = json.loads(line)
        except ValueError:
            rejected.append(line)
            continue
        if item == []:
            parsed = True
            continue
        if not isinstance(item, list) or len(item) != 4:
            rejected.append(item)
            continue
        parsed = True
        facts.append(
            dict(zip(("label", "lines", "role", "text"), item), receipt=receipt)
        )
    complete = finish_reason == "stop" and parsed and not rejected
    return {
        "state": "read" if complete else "partial",
        "receipt": receipt,
        "finish_reason": finish_reason,
        "observations": facts,
        "rejected": rejected,
        "reason": "" if complete else "incomplete_source_response",
    }
