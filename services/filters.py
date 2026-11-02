"""Filter a NetworkX network without modifying the imported dataset.

Order of operations:
  1. Remove edges with weight below the requested minimum.
  2. Keep selected *original-network* Louvain communities, if requested.
  3. Remove nodes below the requested total degree (one pass).
  4. Optionally keep the largest weakly connected component.

Community IDs always refer to the ORIGINAL graph. Recalculation of community
membership after filtering is handled separately by communities.py.
"""
from __future__ import annotations

import math
from collections.abc import Mapping

import networkx as nx

from .communities import original_communities


def _nonnegative_float(value, name: str) -> float:
    try:
        number = float(0 if value is None or value == "" else value)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"{name} must be a non-negative number") from exc
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{name} must be a finite, non-negative number")
    return number


def _nonnegative_int(value, name: str) -> int:
    number = _nonnegative_float(value, name)
    if not number.is_integer():
        raise ValueError(f"{name} must be an integer")
    return int(number)


def filtered_graph(dataset: str, original: nx.Graph, spec: Mapping | None) -> nx.Graph:
    """Return a filtered *copy* of the network.

    Accepted filter keys:
      min_weight:  Minimum edge interaction count (default: 0).
      communities: Sequence of original Louvain community IDs.
      min_degree: Minimum total node degree after the first two filters.
      giant: Keep only the largest weakly connected component.

    Important: min_degree is one pass, not an iterative k-core filter.
    Edges are NEVER fabricated. Isolated nodes are retained unless removed by
    min_degree > 0 or by the giant component filter.
    """
    if spec is None:
        spec = {}
    if not isinstance(spec, Mapping):
        raise ValueError("filters must be an object")

    result = original.copy()

    # AI focus: an explicit, reversible induced subgraph of verified accounts.
    # 0 hops keeps only named nodes and internal relationships; 1 hop also
    # includes their immediate counterparties. No new edges are inferred.
    focus_nodes = spec.get("focus_nodes", [])
    if focus_nodes is None:
        focus_nodes = []
    if not isinstance(focus_nodes, (list, tuple)) or len(focus_nodes) > 40:
        raise ValueError("focus_nodes must be a list with at most 40 account IDs")
    if focus_nodes:
        if any(not isinstance(node, str) or not 0 < len(node) <= 150
               for node in focus_nodes):
            raise ValueError("Invalid focus_nodes entries")
        seeds = set(focus_nodes)
        unknown = seeds - {str(node) for node in original.nodes}
        if unknown:
            raise ValueError("Unknown focus node ID")
        hops = _nonnegative_int(spec.get("focus_hops", 0), "focus_hops")
        if hops > 1:
            raise ValueError("focus_hops must be 0 or 1")
        selected_nodes = set(seeds)
        if hops:
            for seed in seeds:
                if original.is_directed():
                    selected_nodes.update(str(n) for n in original.predecessors(seed))
                    selected_nodes.update(str(n) for n in original.successors(seed))
                else:
                    selected_nodes.update(str(n) for n in original.neighbors(seed))
        # Work on an induced subgraph, which keeps only actually observed links.
        result = original.subgraph(selected_nodes).copy()

    min_weight = _nonnegative_float(spec.get("min_weight", 0), "min_weight")
    if min_weight:
        to_drop = []
        for source, target, attrs in result.edges(data=True):
            weight = _nonnegative_float(attrs.get("weight", 1), "edge weight")
            if weight < min_weight:
                to_drop.append((source, target))
        result.remove_edges_from(to_drop)

    selected = spec.get("communities", [])
    if selected is None:
        selected = []
    if not isinstance(selected, (list, tuple, set)):
        raise ValueError("communities must be a list of community IDs")
    if selected:
        selected_ids = {_nonnegative_int(id_, "community ID") for id_ in selected}
        membership = original_communities(dataset)
        result.remove_nodes_from(
            node for node in list(result.nodes)
            if membership.get(str(node)) not in selected_ids
        )

    min_degree = _nonnegative_int(spec.get("min_degree", 0), "min_degree")
    if min_degree:
        result.remove_nodes_from(
            node for node, degree in list(result.degree())
            if degree < min_degree
        )

    if spec.get("giant", False) and result.number_of_nodes():
        components = (
            nx.weakly_connected_components(result)
            if result.is_directed()
            else nx.connected_components(result)
        )
        # Deterministic tie-breaking for equally sized components.
        biggest = min(
            components,
            key=lambda group: (-len(group), min(map(str, group))),
        )
        result = result.subgraph(biggest).copy()

    return result
