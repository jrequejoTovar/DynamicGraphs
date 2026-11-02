"""Compact, verifiable NetworkX summaries for the local AI interpreter.

This module intentionally does not call a language model. The ranking can
be replaced by ai_routes when centrality was computed on the original graph.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any

import networkx as nx

from services.business_patterns import financial_business_patterns


def _safe_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 6) if math.isfinite(number) else None


def _components(graph: nx.Graph) -> dict:
    if graph.number_of_nodes() == 0:
        return {"weak_components": 0, "largest_component_nodes": 0,
                "largest_component_share_pct": 0.0}
    groups = (nx.weakly_connected_components(graph) if graph.is_directed()
              else nx.connected_components(graph))
    sizes = [len(group) for group in groups]
    largest = max(sizes, default=0)
    return {"weak_components": len(sizes), "largest_component_nodes": largest,
            "largest_component_share_pct": round(100 * largest / graph.number_of_nodes(), 2)}


def _communities(graph: nx.Graph) -> dict:
    counts = Counter(str(attrs["community"]) for _, attrs in graph.nodes(data=True)
                     if attrs.get("community") is not None)
    return {"count": len(counts), "available": bool(counts),
            "largest": [{"community": key, "nodes": value,
                         "share_pct": round(100 * value / max(1, graph.number_of_nodes()), 2)}
                        for key, value in counts.most_common(6)]}


def _simple_ranking(graph: nx.Graph, metric: str, top_n: int) -> dict:
    if metric == "degree":
        scores = dict(graph.degree())
    elif metric == "in_degree":
        scores = dict(graph.in_degree() if graph.is_directed() else graph.degree())
    elif metric == "out_degree":
        scores = dict(graph.out_degree() if graph.is_directed() else graph.degree())
    elif metric == "weighted_degree":
        scores = dict(graph.degree(weight="weight"))
    elif metric == "weighted_in_degree":
        scores = dict(graph.in_degree(weight="weight") if graph.is_directed()
                      else graph.degree(weight="weight"))
    elif metric == "weighted_out_degree":
        scores = dict(graph.out_degree(weight="weight") if graph.is_directed()
                      else graph.degree(weight="weight"))
    else:
        # Expensive centralities are calculated by the caller.
        scores = {}
    top = sorted(scores.items(), key=lambda item: (-item[1], str(item[0])))[:top_n]
    return {"metric": metric, "available": bool(top),
            "nodes": [{"id": str(node),
                       "label": str(graph.nodes[node].get("label") or node)[:120],
                       "metric_value": _safe_number(value),
                       "degree": int(graph.degree(node))}
                      for node, value in top]}


def _financial_indicators(graph: nx.Graph, limit: int = 8) -> dict:
    """Verified topology-only signals; not a fraud classifier.

    Weight is transaction count in this dataset, never monetary value.
    Calculations describe only the supplied (possibly filtered) graph.
    """
    if not graph.is_directed():
        return {"available": False, "reason": "Directed graph required"}
    g = graph
    count = g.number_of_nodes()
    if not count:
        return {"available": True, "reciprocity": None, "top_accounts": [],
                "reciprocal_pairs": 0, "three_node_cycles": 0}

    # A mutual relationship is counted once per unordered account pair.
    reciprocal_pairs = sorted(
        ((str(u), str(v)) for u, v in g.edges() if u != v and g.has_edge(v, u)
         and str(u) < str(v))
    )
    reciprocal_edges = sum(2 for _ in reciprocal_pairs)
    nonself_edges = sum(1 for u, v in g.edges() if u != v)

    # Count distinct directed 3-cycles once; bounded complexity for the lab.
    cycles = set()
    if count <= 1000:
        for a in g.nodes():
            for b in g.successors(a):
                if b == a:
                    continue
                for c in g.successors(b):
                    if c != a and c != b and g.has_edge(c, a):
                        seq = (str(a), str(b), str(c))
                        rotations = (seq, seq[1:] + seq[:1], seq[2:] + seq[:2])
                        cycles.add(min(rotations))

    records = []
    for node in g.nodes():
        indeg, outdeg = g.in_degree(node), g.out_degree(node)
        weight_in = float(g.in_degree(node, weight="weight"))
        weight_out = float(g.out_degree(node, weight="weight"))
        neighbors = set(g.predecessors(node)) | set(g.successors(node))
        records.append({
            "id": str(node),
            "label": str(g.nodes[node].get("label") or node)[:120],
            "degree": int(g.degree(node)),
            "in_degree": int(indeg), "out_degree": int(outdeg),
            "weighted_in": _safe_number(weight_in),
            "weighted_out": _safe_number(weight_out),
            "weighted_total": _safe_number(weight_in + weight_out),
            "unique_counterparties": len(neighbors),
            "direction_imbalance": round(abs(indeg - outdeg) / max(1, indeg + outdeg), 3),
        })
    by_degree = sorted(records, key=lambda x: (-x["degree"], x["id"]))[:limit]
    by_weight = sorted(records, key=lambda x: (-x["weighted_total"], x["id"]))[:limit]
    by_imbalance = sorted(
        (r for r in records if r["degree"] >= 3),
        key=lambda x: (-x["direction_imbalance"], -x["degree"], x["id"]),
    )[:limit]
    return {
        "available": True,
        "scope": "visible_network",
        "weight_meaning": "number_of_transactions_not_amount",
        "reciprocity": round(reciprocal_edges / nonself_edges, 4) if nonself_edges else None,
        "reciprocal_pairs": len(reciprocal_pairs),
        "three_node_cycles": len(cycles) if count <= 1000 else None,
        "top_by_degree": by_degree,
        "top_by_weighted_total": by_weight,
        "top_by_direction_imbalance": by_imbalance,
        "caveat": "These are structural screening signals, not evidence of fraud or financial loss.",
    }


def compare_snapshots(previous: dict, current: dict) -> dict:
    old, new = previous["network"], current["network"]
    visual_old, visual_new = previous["visualization"], current["visualization"]
    same = previous.get("dataset_id") == current.get("dataset_id")
    return {
        "same_dataset": same,
        "nodes_before": old["nodes"], "nodes_after": new["nodes"],
        "nodes_delta": new["nodes"] - old["nodes"],
        "edges_before": old["edges"], "edges_after": new["edges"],
        "edges_delta": new["edges"] - old["edges"],
        "previous_size_metric": visual_old["size_metric"],
        "current_size_metric": visual_new["size_metric"],
        "metric_changed": visual_old["size_metric"] != visual_new["size_metric"],
        "previous_layout": visual_old["layout"],
        "current_layout": visual_new["layout"],
        "layout_changed": visual_old["layout"] != visual_new["layout"],
        "top_accounts_before": previous.get("ranking", {}).get("nodes", [])[:5],
        "top_accounts_after": current.get("ranking", {}).get("nodes", [])[:5],
        "financial_before": (previous.get("financial_indicators") or {}).get("top_by_weighted_total", [])[:5],
        "financial_after": (current.get("financial_indicators") or {}).get("top_by_weighted_total", [])[:5],
    }


def build_graph_snapshot(
    graph: nx.Graph,
    dataset_id: str,
    dataset_context: dict,
    size_metric: str = "degree",
    layout: str = "forceatlas2",
    filters: dict | None = None,
    previous_snapshot: dict | None = None,
    top_n: int = 8,
) -> dict:
    if not isinstance(graph, nx.Graph):
        raise TypeError("graph must be a NetworkX graph")
    nodes = graph.number_of_nodes()
    snapshot = {
        "dataset_id": dataset_id,
        "dataset_context": dataset_context,
        "network": {
            "nodes": nodes, "edges": graph.number_of_edges(),
            "directed": graph.is_directed(),
            "density": round(nx.density(graph), 6) if nodes > 1 else 0,
            **_components(graph),
        },
        "visualization": {"size_metric": size_metric, "layout": layout,
                          "filters": filters or {}},
        "ranking": _simple_ranking(graph, size_metric, top_n),
        "communities": _communities(graph),
        "comparison": None,
    }
    if dataset_context.get("domain", "").lower().startswith("financial"):
        snapshot["financial_indicators"] = _financial_indicators(graph)
        snapshot["business_patterns"] = financial_business_patterns(graph)
    if previous_snapshot is not None:
        snapshot["comparison"] = compare_snapshots(previous_snapshot, snapshot)
    return snapshot
