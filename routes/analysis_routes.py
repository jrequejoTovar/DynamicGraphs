"""API endpoints for graph layouts and node inspection.

Registered in app.py under /api:
    POST /api/layout
    POST /api/node
"""

from flask import Blueprint, jsonify, request

from services.graph_loader import load_graph
from services.filters import filtered_graph
from services.layouts import compute_layout


analysis_routes = Blueprint("analysis", __name__)


def _payload():
    """Require a JSON object rather than silently accepting malformed input."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object")
    return data


@analysis_routes.post("/layout")
def layout():
    """Compute new positions without modifying the original graph.

    Example body:
      {
        "dataset": "bluesky",
        "filters": {"giant": true},
        "layout": "forceatlas2",
        "options": {"scaling": 2, "gravity": 1, "iterations": 60},
        "positions": {},
        "sizes": {}
      }
    """
    try:
        data = _payload()
        dataset = data.get("dataset", "bluesky")
        original = load_graph(dataset)
        graph = filtered_graph(dataset, original, data.get("filters", {}))

        positions = compute_layout(
            graph,
            layout=data.get("layout", "forceatlas2"),
            options=data.get("options", {}),
            current=data.get("positions"),
            sizes=data.get("sizes"),
        )
        return jsonify({
            "positions": positions,
            "layout": data.get("layout", "forceatlas2"),
            "nodes": graph.number_of_nodes(),
        })
    except (ValueError, TypeError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": f"Dataset file not found: {exc.filename}"}), 404


@analysis_routes.post("/node")
def node_details():
    """Return original-node attributes and direct-neighbour summaries."""
    try:
        data = _payload()
        dataset = data.get("dataset", "bluesky")
        node_id = str(data.get("id", ""))
        if not node_id:
            raise ValueError("'id' is required")

        graph = load_graph(dataset)
        if node_id not in graph:
            return jsonify({"error": "Node not found"}), 404

        attributes = graph.nodes[node_id]
        # Convert values to JSON-safe primitives without discarding labels.
        safe_attributes = {
            str(key): value if isinstance(value, (str, int, float, bool, type(None)))
            else str(value)
            for key, value in attributes.items()
        }
        if graph.is_directed():
            in_degree = graph.in_degree(node_id)
            out_degree = graph.out_degree(node_id)
            incoming = [str(n) for n in list(graph.predecessors(node_id))[:20]]
            outgoing = [str(n) for n in list(graph.successors(node_id))[:20]]
        else:
            in_degree = out_degree = graph.degree(node_id)
            incoming = outgoing = [str(n) for n in list(graph.neighbors(node_id))[:20]]

        return jsonify({
            "id": node_id,
            "label": str(attributes.get("label") or node_id),
            "attributes": safe_attributes,
            "in_degree": int(in_degree),
            "out_degree": int(out_degree),
            "weighted_degree": float(graph.degree(node_id, weight="weight")),
            "incoming": incoming,
            "outgoing": outgoing,
        })
    except (ValueError, TypeError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": f"Dataset file not found: {exc.filename}"}), 404
