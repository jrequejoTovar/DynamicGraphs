"""Graph layout algorithms for Network Analytics Studio.

- fast_positions: quick deterministic initial placement (NOT ForceAtlas2).
- compute_layout: Circular, Grid, Random and NetworkX ForceAtlas2.

ForceAtlas2 is computed on the backend; controls are supplied by the frontend.
"""

from __future__ import annotations

import math
import random

import networkx as nx
import numpy as np


MAX_FORCEATLAS_NODES = 850
MAX_ITERATIONS = 150
SEED = 42


def _number(value, name, minimum, maximum):
    """Validate a numeric layout setting."""
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be numeric") from exc
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return result


def fast_positions(graph: nx.Graph, communities: dict) -> dict[str, list[float]]:
    """Fast, reproducible placement by community for the initial rendering.

    This is an illustrative layout, not a force-directed calculation.
    """
    buckets = {}
    for node in graph.nodes:
        buckets.setdefault(communities.get(str(node), -1), []).append(node)

    community_ids = sorted(buckets, key=lambda c: (-len(buckets[c]), str(c)))
    positions = {}
    rng = random.Random(SEED)

    for i, community_id in enumerate(community_ids):
        angle = 2 * math.pi * i / max(len(community_ids), 1)
        distance = 230 * (1 + (i // 8) * 0.5) if len(community_ids) > 1 else 0
        center_x = distance * math.cos(angle)
        center_y = distance * math.sin(angle)

        members = sorted(
            buckets[community_id],
            key=lambda n: (-graph.degree(n), str(n)),
        )
        for j, node in enumerate(members):
            a = 2.39996323 * j + rng.random() * 0.15
            radius = min(12 * math.sqrt(j), 190)
            positions[str(node)] = [
                round(center_x + radius * math.cos(a), 3),
                round(center_y + radius * math.sin(a), 3),
            ]

    return positions


def compute_layout(
    graph: nx.Graph,
    layout: str = "forceatlas2",
    options: dict | None = None,
    current: dict | None = None,
    sizes: dict | None = None,
) -> dict[str, list[float]]:
    """Return node positions keyed by string node ID.

    Supported options for ForceAtlas2:
      iterations, scaling, gravity, prevent_overlap, use_weights,
      linlog, strong_gravity.
    """
    if graph.number_of_nodes() == 0:
        return {}
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise ValueError("Layout options must be a JSON object")

    nodes = sorted(graph.nodes, key=str)
    count = len(nodes)
    rng = random.Random(SEED)

    if layout == "circular":
        return {
            str(node): [
                round(250 * math.cos(2 * math.pi * i / count), 3),
                round(250 * math.sin(2 * math.pi * i / count), 3),
            ]
            for i, node in enumerate(nodes)
        }

    if layout == "grid":
        columns = math.ceil(math.sqrt(count))
        return {
            str(node): [float((i % columns) * 28), float((i // columns) * 28)]
            for i, node in enumerate(nodes)
        }

    if layout == "random":
        return {
            str(node): [round(rng.uniform(-300, 300), 3), round(rng.uniform(-250, 250), 3)]
            for node in nodes
        }

    if layout != "forceatlas2":
        raise ValueError(f"Unknown layout: {layout}")

    if count > MAX_FORCEATLAS_NODES:
        raise ValueError(
            f"ForceAtlas2 accepts at most {MAX_FORCEATLAS_NODES} visible nodes "
            "in this version. Filter the network before applying it."
        )

    iterations = int(_number(options.get("iterations", 60), "iterations", 1, MAX_ITERATIONS))
    scaling = _number(options.get("scaling", 2), "scaling", 0.1, 50)
    gravity = _number(options.get("gravity", 1), "gravity", 0, 20)

    # Use current positions to continue/restart the interactive layout.
    initial = None
    if isinstance(current, dict) and all(str(node) in current for node in nodes):
        try:
            initial = {
                node: np.asarray(current[str(node)], dtype=float)
                for node in nodes
            }
            if any(p.shape != (2,) or not np.isfinite(p).all() for p in initial.values()):
                initial = None
        except (ValueError, TypeError):
            initial = None

    # The node_size parameter influences separation; it does not provide a
    # pixel-perfect no-overlap guarantee, and results differ from Gephi.
    prevent_overlap = options.get("prevent_overlap", True)
    node_sizes = None
    if prevent_overlap:
        sizes = sizes if isinstance(sizes, dict) else {}
        node_sizes = {}
        for node in nodes:
            size = _number(sizes.get(str(node), 5), "node size", 0, 1000)
            node_sizes[node] = max(1.0, size) * 0.6

    positions = nx.forceatlas2_layout(
        graph,
        pos=initial,
        max_iter=iterations,
        scaling_ratio=scaling,
        gravity=gravity,
        linlog=bool(options.get("linlog", False)),
        strong_gravity=bool(options.get("strong_gravity", False)),
        weight="weight" if options.get("use_weights", True) else None,
        node_size=node_sizes,
        seed=SEED,
    )

    return {
        str(node): [round(float(point[0]), 3), round(float(point[1]), 3)]
        for node, point in positions.items()
    }
