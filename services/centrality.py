
"""Network centrality calculations for Network Analytics Studio.

The caller decides whether *graph* is the original or the filtered network.
Interaction counts (edge ``weight``) represent strength, not distance.
"""
from __future__ import annotations

import networkx as nx


SUPPORTED_METRICS = (
    "degree",
    "in_degree",
    "out_degree",
    "weighted_degree",
    "weighted_in_degree",
    "weighted_out_degree",
    "betweenness",
    "pagerank",
)


def values(graph: nx.Graph, measure: str = "in_degree") -> dict:
    """Return {node_id: metric_value} for every node in graph.

    Betweenness is exact for at most 120 nodes.
    Larger networks use a reproducible sample of 120 source nodes.
    """

    if measure not in SUPPORTED_METRICS:
        raise ValueError(
            f"Unknown centrality metric: {measure}. "
            f"Available: {', '.join(SUPPORTED_METRICS)}"
        )

    if graph.number_of_nodes() == 0:
        return {}

    if measure == "degree":
        result = dict(graph.degree())

    elif measure == "in_degree":
        result = (
            dict(graph.in_degree())
            if graph.is_directed()
            else dict(graph.degree())
        )

    elif measure == "out_degree":
        result = (
            dict(graph.out_degree())
            if graph.is_directed()
            else dict(graph.degree())
        )

    elif measure == "weighted_degree":
        result = dict(graph.degree(weight="weight"))

    elif measure == "weighted_in_degree":
        result = (
            dict(graph.in_degree(weight="weight"))
            if graph.is_directed()
            else dict(graph.degree(weight="weight"))
        )

    elif measure == "weighted_out_degree":
        result = (
            dict(graph.out_degree(weight="weight"))
            if graph.is_directed()
            else dict(graph.degree(weight="weight"))
        )

    elif measure == "betweenness":
        sample_size = (
            120 if graph.number_of_nodes() > 120 else None
        )

        result = nx.betweenness_centrality(
            graph,
            k=sample_size,
            normalized=True,
            weight=None,
            seed=42,
        )

    else:  # pagerank
        result = nx.pagerank(
            graph,
            alpha=0.85,
            weight="weight",
            max_iter=300,
            tol=1e-6,
        )

    return {
        node: float(value)
        for node, value in result.items()
    }
