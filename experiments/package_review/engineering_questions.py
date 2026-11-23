"""Profile-scoped retrieval and evidence checks for an engineer's question."""

import re
from collections import defaultdict
from copy import deepcopy
from decimal import Decimal


def words(text):
    return tuple(re.findall(r"[^\W_]+", text.casefold().replace("ё", "е")))


def contains_term(text, term):
    phrase = words(term)
    tokens = words(text)
    return bool(phrase) and any(
        tokens[i : i + len(phrase)] == phrase for i in range(len(tokens))
    )


def matching_evidence(question, readings, search=None):
    """Broad retrieval by verified scope/role includes paraphrases outside the vocabulary.

    The review adapter must resolve context from cited original lines. Retrieval
    alone cannot satisfy a question, produce a conflict or establish absence.
    """
    terms = [question["subject"], *question.get("aliases", [])]
    roles = {*question["required_roles"], question.get("authority_role")}
    scoped = {f["id"]: f for f in readings if f["scope"] == question["scope"]}
    # A local index can nominate further addresses with no lexical or role match.
    # Candidate ids are capabilities scoped to this question; reject substitution.
    nominated = (
        search(deepcopy(question), deepcopy(list(scoped.values())))
        if search and scoped
        else {}
    )
    if not isinstance(nominated, dict) or any(
        key not in scoped or not isinstance(reason, str) or not reason.strip()
        for key, reason in nominated.items()
    ):
        raise ValueError("semantic search returned an ungrounded candidate")
    candidates = []
    for fact in scoped.values():
        material = " ".join([fact["label"], *fact["original_lines"]])
        term = next((term for term in terms if contains_term(material, term)), None)
        nominations = fact.get("proposed_questions", [])
        reader_link = isinstance(nominations, list) and question["id"] in nominations
        reason = nominated.get(fact["id"])
        if reason or reader_link or term or fact["document_role"] in roles:
            candidates.append(
                {
                    **fact,
                    "retrieval": (
                        "semantic_index"
                        if reason
                        else "reader_nomination"
                        if reader_link
                        else "subject_term"
                        if term
                        else "scope_role_context"
                    ),
                    "search_reason": reason,
                    "matched_term": term,
                }
            )
    return sorted(candidates, key=lambda f: f["id"])


def source_address(fact):
    return fact["source"], fact["unit"], tuple(fact["lines"])


def citation(item, cited):
    if not isinstance(item, dict) or not isinstance(item.get("fact"), str):
        return None
    fact = cited.get(item["fact"])
    quote = item.get("quote")
    if not fact or not isinstance(quote, str) or not quote.strip():
        return None
    if not any(quote in line for line in fact["original_lines"]):
        return None
    return source_address(fact)


def quoted_value(quote):
    """Use the same physical length when the cited value is a standalone SI quantity."""
    scale = {
        "мм": "0.001",
        "mm": "0.001",
        "см": "0.01",
        "cm": "0.01",
        "м": "1",
        "m": "1",
    }
    match = re.fullmatch(
        r"\s*([+-]?\d+(?:[.,]\d+)?)\s*(мм|см|м|mm|cm|m)\s*", quote, re.IGNORECASE
    )
    if match:
        return "length", Decimal(match[1].replace(",", ".")) * Decimal(
            scale[match[2].casefold()]
        )
    return "literal", " ".join(quote.casefold().split())


def check_review(question, review, evidence, model):
    """Return independently supported disposition and the material addresses it rests on."""
    if (
        not isinstance(review, dict)
        or not isinstance(review.get("reason"), str)
        or not review["reason"].strip()
    ):
        return None
    ids = review.get("basis")
    if (
        not isinstance(ids, list)
        or not ids
        or not all(isinstance(i, str) and i in evidence for i in ids)
    ):
        return None
    cited = {i: evidence[i] for i in ids}
    if any(f["model"] != model for f in cited.values()):
        return None
    required = set(question["required_roles"])
    supported = {f["document_role"] for f in cited.values() if f["role"] == "data"}
    status = review.get("status")
    if status == "covered" and required <= supported:
        return (
            status,
            frozenset(),
            frozenset(source_address(f) for f in cited.values() if f["role"] == "data"),
        )
    if status == "missing":
        missing = review.get("missing_roles")
        if (
            not isinstance(missing, list)
            or not missing
            or not all(isinstance(r, str) and r in required for r in missing)
        ):
            return None
        item = review.get("attestation")
        location = citation(item, cited)
        if not location or not question.get("authority_role"):
            return None
        authority = cited[item["fact"]]
        quote_terms = words(item["quote"])
        labels = [authority["label"], question["subject"], *question.get("aliases", [])]
        # A heading on its own cannot attest that delivery is outstanding.
        if not quote_terms or any(
            contains_term(label, item["quote"]) for label in labels
        ):
            return None
        if authority["document_role"] != question["authority_role"]:
            return None
        # A current, substantive candidate in the allegedly missing role may
        # supersede a prior promise of delivery. A client request must wait.
        if any(
            f["document_role"] in missing and f["role"] == "data"
            for f in evidence.values()
        ):
            return None
        return (
            status,
            frozenset(missing),
            frozenset([(location, quoted_value(item["quote"]))]),
        )
    if status == "conflict" and required <= supported:
        quoted = review.get("opposed")
        if not isinstance(quoted, list) or len(quoted) != 2:
            return None
        addresses = [citation(item, cited) for item in quoted]
        if not all(addresses) or len({a[0] for a in addresses}) != 2:
            return None
        anchor_roles = {cited[item["fact"]]["document_role"] for item in quoted}
        if not anchor_roles <= required or (
            len(required) == 2 and anchor_roles != required
        ):
            return None
        if quoted_value(quoted[0]["quote"]) == quoted_value(quoted[1]["quote"]):
            return None
        if any(cited[item["fact"]]["role"] != "data" for item in quoted):
            return None
        return (
            status,
            frozenset(),
            frozenset(
                (addr, quoted_value(item["quote"]))
                for addr, item in zip(addresses, quoted)
            ),
        )
    return None


def disposition(question, reviews, candidates, models):
    by_id = {f["id"]: f for f in candidates}
    if not isinstance(reviews, dict) or set(reviews) != set(models):
        return "needs_review", [], "independent_reviews_required"
    decisions = [
        check_review(question, reviews[model], by_id, model) for model in models
    ]
    if not all(decisions) or decisions[0] != decisions[1]:
        return "needs_review", [], "unresolved_evidence_or_disagreement"
    basis = sorted({i for review in reviews.values() for i in review["basis"]})
    return decisions[0][0], basis, "addressed_independent_reviews"


def reader_positions(reviews, candidates, models):
    """Expose each reader's verifiable source lines even while the decision is held."""
    positions = []
    for model in models:
        review = reviews.get(model) if isinstance(reviews, dict) else None
        review = review if isinstance(review, dict) else {}
        basis = review.get("basis")
        citations = []
        for fact in candidates:
            if (
                fact["model"] != model
                or not isinstance(basis, list)
                or fact["id"] not in basis
            ):
                continue
            for row, text in zip(fact["lines"], fact["original_lines"]):
                item = {
                    "document": fact["document"],
                    "source": fact["source"],
                    "unit": fact["unit"],
                    "rows": [row + 1],
                    "quote": text,
                }
                if item not in citations:
                    citations.append(item)
        positions.append(
            {
                "model": model,
                "status": review.get("status"),
                "reason": review.get("reason"),
                "citations": citations,
            }
        )
    return positions


def letter_citations(review, candidates):
    by_id = {f["id"]: f for f in candidates}
    quotes = (
        [review["attestation"]] if review["status"] == "missing" else review["opposed"]
    )
    sources = []
    for item in quotes:
        fact = by_id[item["fact"]]
        rows = [
            n + 1
            for n, text in zip(fact["lines"], fact["original_lines"])
            if item["quote"] in text
        ]
        sources.append(
            {
                "document": fact["document"],
                "source": fact["source"],
                "unit": fact["unit"],
                "rows": rows,
                "quote": item["quote"],
            }
        )
    return sources


def letter_text(proposals):
    if not proposals:
        return ""
    paragraphs = ["Уважаемые коллеги!"]
    for number, proposal in enumerate(proposals, 1):
        support, context = [], []
        for item in proposal["citations"]:
            rows = ", ".join(map(str, item["rows"]))
            document = item["document"]
            unit = item["unit"]
            address = (
                unit if unit.startswith(document + "/") else f"{document} / {unit}"
            )
            group = context if item.get("role") == "context" else support
            group.append(f"«{item['quote']}» ({address}, строка {rows})")
        paragraphs.append(
            f"{number}. {proposal['text']} Основания в документах — "
            + ", ".join(support)
            + "."
        )
        if context:
            paragraphs[-1] += (
                " Сверенные строки контекста — " + ", ".join(context) + "."
            )
    return "\n\n".join(paragraphs)


def scope_summary(questions):
    grouped = defaultdict(list)
    for q in questions:
        grouped[q["scope"]].append(q)
    return {
        scope: {
            status: [q["id"] for q in rows if q["status"] == status]
            for status in sorted({q["status"] for q in rows})
        }
        for scope, rows in grouped.items()
    }
