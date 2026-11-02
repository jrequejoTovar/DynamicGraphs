"""Deterministic, explainable financial-network screening signals.

Patterns are reasons for *manual investigation*, not probability of fraud.
Edge direction: sender -> receiver.
Edge weight: observed transaction count.
Edge Total_Amount_EUR: aggregated EUR amount for that directed account pair.
No transaction timestamps are available: detected cycles are TOPOLOGICAL ONLY.
"""
from __future__ import annotations

import networkx as nx


def _numeric(value) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


def _money(v: float) -> float:
    return round(v, 2)


def _edge_amount(data: dict) -> float:
    return _numeric(data.get("Total_Amount_EUR"))


def _cycle_key(seq):
    """Canonical ordering of one directed cycle; do not reverse direction."""
    seq = [str(s) for s in seq]
    rotations = [tuple(seq[i:] + seq[:i]) for i in range(len(seq))]
    return min(rotations)


def financial_business_patterns(graph: nx.Graph, max_cases: int = 4) -> dict:
    if not graph.is_directed():
        return {"available": False, "reason": "Directed financial graph required"}

    if graph.number_of_edges() == 0:
        return {"available": True, "priority_cases": [], "other_signals": [],
                "limitations": ["Graph has no observed transactions"]}

    amounts_available = all(
        "Total_Amount_EUR" in d for _, _, d in graph.edges(data=True)
    )
    edge_amounts = sorted(_edge_amount(data) for _, _, data in graph.edges(data=True))
    amount_cutoff = edge_amounts[int((len(edge_amounts) - 1) * 0.75)] if amounts_available else None
    amount_network_total = sum(edge_amounts) if amounts_available else None

    # Restrict cycle discovery to the upper quartile of directed relationships
    # by aggregated EUR value. This is a screening heuristic, not a risk threshold.
    high_value = nx.DiGraph()
    if amounts_available:
        high_value.add_edges_from(
            (u, v) for u, v, data in graph.edges(data=True)
            if u != v and _edge_amount(data) >= amount_cutoff
        )

    cycles = []
    # Bound work so dataset growth doesn't freeze Flask. Graph size restriction
    # is a safety/performance limit, NOT evidence of absence of cycles.
    if amounts_available and high_value.number_of_nodes() <= 400 and high_value.number_of_edges() <= 900:
        seen = set()
        for cycle in nx.simple_cycles(high_value, length_bound=8):
            if not 3 <= len(cycle) <= 8:
                continue
            signature = _cycle_key(cycle)
            if signature in seen:
                continue
            seen.add(signature)
            ids = list(signature)
            sub = graph.subgraph(ids)
            internal = list(sub.edges(data=True))
            euros = sum(_edge_amount(data) for _, _, data in internal)
            tx = sum(_numeric(data.get("Transaction_Count", data.get("weight", 1)))
                     for _, _, data in internal)
            cycles.append({
                "id": "cycle:" + ":".join(ids),
                "type": "high_value_directed_cycle",
                "account_ids": ids,
                "cycle_path": ids + ids[:1],
                "account_count": len(ids),
                "internal_relationships": len(internal),
                "internal_transactions": int(tx),
                "internal_amount_eur": _money(euros),
                "share_of_observed_amount_pct": round(100 * euros / amount_network_total, 2)
                if amount_network_total else None,
                "screening_reason": (
                    "A directed cycle exists among higher-amount account relationships; "
                    "the aggregate activity within this group may merit review."
                ),
                "what_to_verify": (
                    "Underlying transaction timestamps, economic purpose, ownership, "
                    "the sequence of transfers and historical/peer baselines."
                ),
                "caveat": (
                    "A directed cycle in an aggregated graph does not establish "
                    "that the same funds circulated or that any activity was unlawful."
                ),
            })

    cycles.sort(key=lambda x: (-x["internal_amount_eur"], -x["account_count"], x["id"]))
    # Avoid returning many nearly identical variations of the same ring.
    unique_cycles = []
    for candidate in cycles:
        group = set(candidate["account_ids"])
        if any(len(group & set(other["account_ids"])) /
               min(len(group), len(other["account_ids"])) >= .75
               for other in unique_cycles):
            continue
        unique_cycles.append(candidate)
        if len(unique_cycles) >= max_cases:
            break

    imbalances = []
    for node in graph.nodes():
        indeg, outdeg = graph.in_degree(node), graph.out_degree(node)
        degree = indeg + outdeg
        if degree < 5:
            continue
        imbalance = abs(indeg - outdeg) / degree
        if imbalance < 0.65:
            continue
        incoming_eur = sum(_edge_amount(d) for _, _, d in graph.in_edges(node, data=True))
        outgoing_eur = sum(_edge_amount(d) for _, _, d in graph.out_edges(node, data=True))
        imbalances.append({
            "account": str(node),
            "in_degree": indeg,
            "out_degree": outdeg,
            "direction_imbalance": round(imbalance, 3),
            "incoming_amount_eur": _money(incoming_eur) if amounts_available else None,
            "outgoing_amount_eur": _money(outgoing_eur) if amounts_available else None,
            "interpretation": (
                "Unbalanced counterparties in the sampled directed graph; "
                "this does not by itself indicate fraud or net cash movement."
            ),
        })
    imbalances.sort(key=lambda r: (-r["direction_imbalance"], -(r["in_degree"]+r["out_degree"]), r["account"]))

    return {
        "available": True,
        "amounts_available": amounts_available,
        "observed_edge_amount_total_eur": _money(amount_network_total) if amounts_available else None,
        "high_value_screening_cutoff_eur": _money(amount_cutoff) if amounts_available else None,
        "priority_cases": unique_cycles,
        "other_signals": imbalances[:6],
        "screening_method": (
            "Enumerate directed cycles of 3–8 accounts whose cycle edges each "
            "fall in the upper quartile of aggregated EUR amounts; rank cycle "
            "groups by total observed EUR across all internal directed edges. "
            "Not a calibrated fraud detector."
        ),
        "limitations": [
            "The graph aggregates transactions by directed account pair; timestamps are unavailable.",
            "Edge weights count transactions, whereas Total_Amount_EUR sums monetary amounts.",
            "The method prioritizes patterns for manual review, not proof or probability of misconduct.",
            "Cycles outside the high-value subset, or longer than eight accounts, may be missed.",
        ],
    }
