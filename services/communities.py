
"""Community detection using weighted Louvain."""

from functools import lru_cache
import math
import networkx as nx

from .graph_loader import load_graph


LOUVAIN_RESOLUTION = 1.0
LOUVAIN_SEED = 42


def _undirected_weighted(graph):
    """Convert a directed graph into a weighted undirected graph."""

    result = nx.Graph()
    result.add_nodes_from(graph.nodes())

    for source, target, attributes in graph.edges(data=True):
        weight = float(attributes.get("weight", 1) or 0)

        if not math.isfinite(weight) or weight < 0:
            raise ValueError("Invalid edge weight")

        if result.has_edge(source, target):
            result[source][target]["weight"] += weight
        else:
            result.add_edge(source, target, weight=weight)

    return result


def _detect(graph):
    """Calculate community membership and modularity."""

    if graph.number_of_nodes() == 0:
        return {}, 0.0

    g = _undirected_weighted(graph)

    if g.number_of_edges() == 0 or g.size(weight="weight") == 0:
        groups = [{node} for node in g.nodes()]
        modularity = 0.0

    else:
        groups = list(
            nx.community.louvain_communities(
                g,
                weight="weight",
                resolution=LOUVAIN_RESOLUTION,
                seed=LOUVAIN_SEED,
            )
        )

        modularity = float(
            nx.community.modularity(
                g,
                groups,
                weight="weight",
                resolution=LOUVAIN_RESOLUTION,
            )
        )

    groups.sort(
        key=lambda group: (
            -len(group),
            min(map(str, group))
        )
    )

    membership = {
        str(node): community_id
        for community_id, group in enumerate(groups)
        for node in group
    }

    return membership, modularity


@lru_cache(maxsize=8)
def original_communities(dataset):
    """Return community labels for the original network."""

    membership, _ = _detect(load_graph(dataset))
    return membership


def recalculate_communities(graph):
    """Recalculate communities on the current graph."""

    return _detect(graph)
