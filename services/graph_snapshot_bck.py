# services/graph_snapshot.py

import math
from collections import Counter
from typing import Optional

import networkx as nx


METRIC_ATTRIBUTES = {
    "betweenness": ("betweenness", "betweenness_centrality"),
    "pagerank": ("pagerank", "page_rank"),
    "eigenvector": ("eigenvector", "eigenvector_centrality"),
}

COMMUNITY_ATTRIBUTES = (
    "community",
    "modularity_class",
    "Modularity Class",
    "community_id",
)


def _safe_number(value):
    """Return a JSON-safe number, or None."""
    try:
        number = float(value)
        if not math.isfinite(number):
            return None
        return round(number, 5)
    except (TypeError, ValueError):
        return None


def _node_label(node_id, attributes):
    """Prefer a readable label over an internal node ID."""
    for key in ("label", "display_name", "name", "handle"):
        value = attributes.get(key)
        if value is not None and str(value).strip():
            return str(value)[:120]

    return str(node_id)[:120]


def _get_community(attributes):
    for key in COMMUNITY_ATTRIBUTES:
        value = attributes.get(key)
        if value is not None:
            return str(value)
    return None


def _metric_values(graph, metric):
    """
    Use NetworkX for degree metrics.
    Use previously calculated node attributes for expensive metrics.
    """
    if metric == "degree":
        return dict(graph.degree())

    if metric == "in_degree":
        if graph.is_directed():
            return dict(graph.in_degree())
        return dict(graph.degree())

    if metric == "out_degree":
        if graph.is_directed():
            return dict(graph.out_degree())
        return dict(graph.degree())

    if metric == "weighted_degree":
        return dict(graph.degree(weight="weight"))

    if metric == "weighted_in_degree":
        if graph.is_directed():
            return dict(graph.in_degree(weight="weight"))
        return dict(graph.degree(weight="weight"))

    if metric == "weighted_out_degree":
        if graph.is_directed():
            return dict(graph.out_degree(weight="weight"))
        return dict(graph.degree(weight="weight"))

    attribute_names = METRIC_ATTRIBUTES.get(metric)

    if attribute_names:
        values = {}

        for node, attrs in graph.nodes(data=True):
            for attribute in attribute_names:
                value = _safe_number(attrs.get(attribute))
                if value is not None:
                    values[node] = value
                    break

        return values

    return {}


def _component_stats(graph):
    if graph.number_of_nodes() == 0:
        return {
            "weak_components": 0,
            "largest_component_nodes": 0,
            "largest_component_share_pct": 0,
        }

    if graph.is_directed():
        components = nx.weakly_connected_components(graph)
    else:
        components = nx.connected_components(graph)

    sizes = [len(component) for component in components]
    largest = max(sizes, default=0)

    return {
        "weak_components": len(sizes),
        "largest_component_nodes": largest,
        "largest_component_share_pct": round(
            100 * largest / graph.number_of_nodes(), 2
        ),
    }


def _community_stats(graph):
    counts = Counter()

    for _, attrs in graph.nodes(data=True):
        community = _get_community(attrs)
        if community is not None:
            counts[community] += 1

    return {
        "count": len(counts),
        "available": bool(counts),
        "largest": [
            {"community": key, "nodes": count}
            for key, count in counts.most_common(6)
        ],
    }


def _top_nodes(graph, metric, limit=8):
    values = _metric_values(graph, metric)

    if not values:
        return {
            "metric": metric,
            "available": False,
            "nodes": [],
        }

    ranking = sorted(
        values.items(),
        key=lambda item: item[1],
        reverse=True,
    )[:limit]

    nodes = []

    for node_id, value in ranking:
        attrs = graph.nodes[node_id]

        node_data = {
            "id": str(node_id),
            "label": _node_label(node_id, attrs),
            "metric_value": _safe_number(value),
            "degree": graph.degree(node_id),
        }

        if graph.is_directed():
            node_data["in_degree"] = graph.in_degree(node_id)
            node_data["out_degree"] = graph.out_degree(node_id)

        community = _get_community(attrs)
        if community is not None:
            node_data["community"] = community

        nodes.append(node_data)

    return {
        "metric": metric,
        "available": True,
        "nodes": nodes,
    }


def compare_snapshots(previous, current):
    """Compare two graph states without asking an LLM to do arithmetic."""
    old = previous["network"]
    new = current["network"]

    same_dataset = previous["dataset_id"] == current["dataset_id"]

    return {
        "same_dataset": same_dataset,
        "previous_size_metric": previous["visualization"]["size_metric"],
        "current_size_metric": current["visualization"]["size_metric"],
        "previous_layout": previous["visualization"]["layout"],
        "current_layout": current["visualization"]["layout"],
        "nodes_before": old["nodes"],
        "nodes_after": new["nodes"],
        "nodes_delta": new["nodes"] - old["nodes"],
        "edges_before": old["edges"],
        "edges_after": new["edges"],
        "edges_delta": new["edges"] - old["edges"],
        "metric_changed": (
            previous["visualization"]["size_metric"]
            != current["visualization"]["size_metric"]
        ),
        "layout_changed": (
            previous["visualization"]["layout"]
            != current["visualization"]["layout"]
        ),
        "top_accounts_before": previous["ranking"]["nodes"][:5],
        "top_accounts_after": current["ranking"]["nodes"][:5],
    }


def build_graph_snapshot(
    graph: nx.Graph,
    dataset_id: str,
    dataset_context: dict,
    size_metric: str = "degree",
    layout: str = "forceatlas2",
    filters: Optional[dict] = None,
    previous_snapshot: Optional[dict] = None,
    top_n: int = 8,
):
    """
    Build the structured context for AI network interpretation.

    graph:
        The actual NetworkX graph being analyzed.

    dataset_context:
        Semantic information about the dataset, such as:
        - domain
        - business_question
        - node_meaning
        - edge_meaning
        - limitations

    previous_snapshot:
        Optional previous state for change interpretation.
    """

    node_count = graph.number_of_nodes()
    edge_count = graph.number_of_edges()

    snapshot = {
        "dataset_id": dataset_id,
        "dataset_context": dataset_context,
        "network": {
            "nodes": node_count,
            "edges": edge_count,
            "directed": graph.is_directed(),
            "density": (
                round(nx.density(graph), 6)
                if node_count > 1 else 0
            ),
            **_component_stats(graph),
        },
        "visualization": {
            "size_metric": size_metric,
            "layout": layout,
            "filters": filters or {},
        },
        "ranking": _top_nodes(
            graph,
            metric=size_metric,
            limit=top_n,
        ),
        "communities": _community_stats(graph),
        "comparison": None,
    }

    if previous_snapshot is not None:
        snapshot["comparison"] = compare_snapshots(
            previous_snapshot,
            snapshot,
        )

    return snapshot