"""AI Network Analyst endpoints.

Register in app.py:
    from routes.ai_routes import ai_routes
    app.register_blueprint(ai_routes, url_prefix="/api")

Routes:
    GET  /api/ai/models
    POST /api/ai/interpret

The browser sends *settings*, never trusted graph statistics. We load the
original dataset, apply the filters in Python, calculate metrics, and only
then ask the local Ollama model to interpret verified results.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from services.ai_interpreter import (
    ALLOWED_METRICS,
    ALLOWED_MODELS,
    DEFAULT_MODEL,
    interpret_snapshot,
)
from services.centrality import values as centrality_values
from services.communities import original_communities, recalculate_communities
from services.filters import filtered_graph
from services.graph_loader import DATASETS, load_graph
from services.graph_snapshot import build_graph_snapshot


ai_routes = Blueprint("ai", __name__)

DATASET_CONTEXT = {
    "bluesky": {
        "domain": "Public social network interactions",
        "business_question": (
            "Which accounts receive attention, which connect parts of the "
            "observed conversation, and how do communities form?"
        ),
        "node_meaning": "One Bluesky account",
        "edge_meaning": (
            "A directed observed reply or explicit mention from one account "
            "to another; weight counts observed interactions"
        ),
        "limitations": [
            "This is a sampled network, not all activity on Bluesky.",
            "A missing outgoing edge does not establish that a user is inactive.",
            "Centrality does not prove influence or agreement.",
            "The observed graph can contain posts beyond the original topic seeds.",
        ],
    },
    "transactions": {
        "domain": "Financial account transaction investigation",
        "business_question": (
            "Which accounts, transfers or connected groups merit further "
            "investigation, and what additional evidence would be needed?"
        ),
        "node_meaning": "One financial account",
        "edge_meaning": (
            "A directed aggregated relationship from sending account to "
            "receiving account; Transaction_Count and amount are distinct attributes"
        ),
        "limitations": [
            "An unusual network structure does not establish fraud.",
            "Edge weight represents transaction count, not monetary amount.",
            "Transaction purpose, account ownership and legitimate context are unknown.",
        ],
    },
}

MAX_TOP_N = 15


def _json_object():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object")
    return payload


def _settings(data):
    """Validate the fields that can influence the analytical interpretation."""
    if not isinstance(data, dict):
        raise ValueError("Graph settings must be an object")

    dataset = data.get("dataset", "bluesky")
    if not isinstance(dataset, str) or dataset not in DATASETS:
        raise ValueError("Unknown dataset")

    metric = data.get("size_metric", data.get("metric", "in_degree"))
    if metric not in ALLOWED_METRICS:
        raise ValueError("Unsupported size metric")

    scope = data.get("metric_scope", "filtered")
    if scope == "visible":
        scope = "filtered"
    if scope not in ("filtered", "original"):
        raise ValueError("metric_scope must be 'filtered' or 'original'")

    community_scope = data.get("community_scope")
    if community_scope is None:
        community_scope = (
            "filtered" if data.get("recalc_communities") else "original"
        )
    if community_scope not in ("filtered", "original"):
        raise ValueError("community_scope must be 'filtered' or 'original'")

    layout = data.get("layout", "forceatlas2")
    if layout not in ("forceatlas2", "circular", "grid", "random"):
        raise ValueError("Unknown layout")

    filters = data.get("filters", {})
    if filters is None:
        filters = {}
    if not isinstance(filters, dict):
        raise ValueError("filters must be an object")

    return {
        "dataset": dataset,
        "filters": filters,
        "size_metric": metric,
        "metric_scope": scope,
        "community_scope": community_scope,
        "layout": layout,
    }


def _snapshot(settings):
    """Build a defensible summary of the actual, server-side graph state."""
    dataset = settings["dataset"]
    original = load_graph(dataset)
    visible = filtered_graph(dataset, original, settings["filters"])

    # Never modify the cached original graph returned by load_graph().
    visible = visible.copy()

    # Louvain classes are relative to the graph on which they were calculated.
    if settings["community_scope"] == "filtered":
        membership, modularity = recalculate_communities(visible)
    else:
        membership = original_communities(dataset)
        modularity = None  # No claim about modularity on the filtered graph.

    for node in visible:
        class_id = membership.get(str(node))
        if class_id is not None:
            visible.nodes[node]["community"] = int(class_id)

    # The current view's ranking may intentionally display full-graph scores.
    # Compute them on the chosen network, but show only *visible* node IDs.
    scoring_graph = original if settings["metric_scope"] == "original" else visible
    scores = centrality_values(scoring_graph, settings["size_metric"])

    snapshot = build_graph_snapshot(
        graph=visible,
        dataset_id=dataset,
        dataset_context=DATASET_CONTEXT[dataset],
        size_metric=settings["size_metric"],
        layout=settings["layout"],
        filters=settings["filters"],
        top_n=MAX_TOP_N,
    )

    selected = sorted(
        ((node, scores[node]) for node in visible if node in scores),
        key=lambda item: (-item[1], str(item[0])),
    )[:MAX_TOP_N]
    top = []
    for node_id, score in selected:
        attrs = visible.nodes[node_id]
        item = {
            "id": str(node_id),
            "label": str(attrs.get("label") or attrs.get("name") or node_id)[:120],
            "metric_value": round(float(score), 6),
            "degree": int(visible.degree(node_id)),
        }
        if visible.is_directed():
            item["in_degree"] = int(visible.in_degree(node_id))
            item["out_degree"] = int(visible.out_degree(node_id))
        if "community" in attrs:
            item["community"] = str(attrs["community"])
        top.append(item)

    snapshot["ranking"] = {
        "metric": settings["size_metric"],
        "available": bool(top),
        "nodes": top,
    }
    snapshot["visualization"].update({
        "metric_scope": settings["metric_scope"],
        "community_scope": settings["community_scope"],
    })
    snapshot["communities"]["calculation_scope"] = settings["community_scope"]
    if modularity is not None:
        snapshot["communities"]["modularity_score"] = round(float(modularity), 6)

    # Distinguish visible topology from the graph on which scores were computed.
    snapshot["network"]["original_nodes"] = original.number_of_nodes()
    snapshot["network"]["original_edges"] = original.number_of_edges()
    return snapshot


@ai_routes.get("/ai/models")
def models():
    """Models permitted by this application, not a claim about Ollama status."""
    return jsonify({"models": list(ALLOWED_MODELS), "default": DEFAULT_MODEL})


@ai_routes.post("/ai/interpret")
def interpret():
    """Interpret a verified graph snapshot with the selected local Ollama model.

    Request example:
        {
          "dataset": "bluesky",
          "filters": {"giant": true},
          "size_metric": "in_degree",
          "metric_scope": "filtered",
          "community_scope": "original",
          "layout": "forceatlas2",
          "model": "qwen3:8b",
          "previous": {
            "dataset": "bluesky", "filters": {},
            "size_metric": "degree", "layout": "forceatlas2"
          }
        }

    The optional previous object contains *configuration*, NOT untrusted
    metrics. Both before/after summaries are calculated again on the server.
    Suggested actions are NEVER executed here.
    """
    try:
        data = _json_object()
        settings = _settings(data)
        model = data.get("model", DEFAULT_MODEL)
        if model not in ALLOWED_MODELS:
            raise ValueError("Unsupported Ollama model")

        current = _snapshot(settings)

        previous_data = data.get("previous")
        if previous_data is not None:
            previous_settings = _settings(previous_data)
            # Different datasets cannot form a meaningful change comparison.
            if previous_settings["dataset"] == settings["dataset"]:
                previous = _snapshot(previous_settings)
                from services.graph_snapshot import compare_snapshots
                current["comparison"] = compare_snapshots(previous, current)

        interpretation = interpret_snapshot(current, model=model)
        return jsonify({"interpretation": interpretation, "snapshot": current})

    except (ValueError, TypeError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": f"Dataset file not found: {exc.filename}"}), 404
    except RuntimeError as exc:
        # Ollama is a local dependency; failed inference is not a client error.
        return jsonify({"error": str(exc)}), 502


@ai_routes.post("/ai/optimize-view")
def optimize_view():
    """Compute a business-led visual plan without altering any server-side graph.

    The browser explicitly decides whether to apply it. The user can restore
    their previous controls and graph view. All node IDs, filters and settings
    originate from a verified candidate calculated on the original dataset.
    """
    try:
        data = _json_object()
        settings = _settings(data)
        model = data.get("model", DEFAULT_MODEL)
        if model not in ALLOWED_MODELS:
            raise ValueError("Unsupported Ollama model")
        from services.view_optimizer import optimize_network_view
        response = optimize_network_view(
            dataset=settings["dataset"],
            model=model,
            goal=data.get("goal", "Reveal the most decision-relevant network pattern"),
        )
        return jsonify(response)
    except (ValueError, TypeError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": f"Dataset file not found: {exc.filename}"}), 404


@ai_routes.post("/ai/interpret-node")
def interpret_node():
    """Interpret the selected node's verified one-hop local network.

    Only the node ID, graph settings and the selected model come from the client.
    Node degrees, neighbours and edges are recomputed against the filtered
    source graph. Nothing suggested by the model is applied automatically.
    """
    try:
        data = _json_object()
        settings = _settings(data)
        model = data.get("model", DEFAULT_MODEL)
        if model not in ALLOWED_MODELS:
            raise ValueError("Unsupported Ollama model")
        requested_id = data.get("node_id")
        if not isinstance(requested_id, str) or not requested_id or len(requested_id) > 512:
            raise ValueError("node_id must be a non-empty string (max 512 characters)")

        graph = filtered_graph(
            settings["dataset"], load_graph(settings["dataset"]), settings["filters"]
        ).copy()
        node = next((n for n in graph if str(n) == requested_id), None)
        if node is None:
            return jsonify({"error": "The selected node is not present in the current filtered view"}), 404

        # Graph-aware adjacency works for both financial and social directed networks.
        if graph.is_directed():
            incoming = list(graph.predecessors(node))
            outgoing = list(graph.successors(node))
            neighbours = set(incoming) | set(outgoing)
        else:
            incoming = outgoing = list(graph.neighbors(node))
            neighbours = set(incoming)
        ego = graph.subgraph({node} | neighbours).copy()
        attrs = graph.nodes[node]
        label = str(attrs.get("label") or attrs.get("name") or node)[:120]

        # Reuse the same snapshot schema and Ollama interpreter as /ai/interpret,
        # but pass a focused, independently verified one-hop subgraph.
        context = dict(DATASET_CONTEXT[settings["dataset"]])
        context["business_question"] = (
            f"Explain the network role of selected node {requested_id!r} "
            f"(label {label!r}) within its observed direct-neighbourhood. "
            "Which verifiable relationships matter, what cannot be inferred, "
            "and what should an analyst check next? "
            "Never imply that network structure alone establishes wrongdoing."
        )
        local = build_graph_snapshot(
            graph=ego,
            dataset_id=settings["dataset"],
            dataset_context=context,
            size_metric=settings["size_metric"],
            layout=settings["layout"],
            filters=settings["filters"],
            top_n=MAX_TOP_N,
        )
        selected = {
            "id": requested_id,
            "label": label,
            "degree": int(graph.degree(node)),
            "in_degree": int(graph.in_degree(node)) if graph.is_directed() else int(graph.degree(node)),
            "out_degree": int(graph.out_degree(node)) if graph.is_directed() else int(graph.degree(node)),
            "direct_neighbours": len(neighbours),
            "local_nodes": ego.number_of_nodes(),
            "local_edges": ego.number_of_edges(),
        }
        local["selected_node"] = selected
        local["investigation_focus"] = (
            "This is a one-hop neighbourhood analysis centered on selected_node. "
            "Do not describe it as the full dataset or full visible network."
        )
        interpretation = interpret_snapshot(local, model=model)
        return jsonify({"interpretation": interpretation, "snapshot": local, "selected_node": selected})
    except (ValueError, TypeError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": f"Dataset file not found: {exc.filename}"}), 404
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
