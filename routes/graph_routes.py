from flask import Blueprint, jsonify, request
import networkx as nx
from services.graph_loader import dataset_list, load_graph
from services.communities import original_communities, recalculate_communities
from services.filters import filtered_graph
from services.centrality import values
from services.layouts import fast_positions

graph_routes = Blueprint('graphs', __name__)

@graph_routes.get('/datasets')
def datasets():
    return jsonify(dataset_list())


def get_request_data():
    payload = request.get_json(silent=True) or {}
    dataset = payload.get('dataset', 'bluesky')
    original = load_graph(dataset)
    g = filtered_graph(dataset, original, payload.get('filters', {}))
    return payload, dataset, original, g


@graph_routes.post('/graph')
def graph():
    try:
        spec, ds, orig, g = get_request_data()
        scope = spec.get('scope', 'filtered')
        measure = spec.get('metric', 'in_degree')
        reference = orig if scope == 'original' else g
        measure_values = values(reference, measure)
        classes = original_communities(ds)
        if spec.get('recalculate_communities'):
            classes, modularity = recalculate_communities(g)
        else:
            modularity = None
        positions = fast_positions(g, classes)
        nodes = []
        for n, attr in g.nodes(data=True):
            nodes.append({'id': str(n), 'label': str(attr.get('label') or n),
                          'category': str(attr.get('category') or ''),
                          'community': classes.get(str(n), -1),
                          'metric': round(float(measure_values.get(n, 0)), 6),
                          'attributes': {str(k): str(v) for k, v in attr.items()
                                         if k not in ('label',) and v is not None},
                          'x': positions[str(n)][0], 'y': positions[str(n)][1]})
        edges = [{'source': str(u), 'target': str(v), 'weight': float(a.get('weight', 1)),
                  'attributes': {str(k): str(x) for k, x in a.items() if x is not None}}
                 for u, v, a in g.edges(data=True)]
        ranking = sorted(nodes, key=lambda n: (-n['metric'], n['id']))[:15]
        return jsonify({'dataset': ds, 'nodes': nodes, 'edges': edges,
                        'rank': [{'id': n['id'], 'label': n['label'], 'value': n['metric']} for n in ranking],
                        'summary': {'nodes': len(nodes), 'edges': len(edges),
                                    'weak_components': nx.number_weakly_connected_components(g) if len(g) else 0,
                                    'communities': len(set(n['community'] for n in nodes)),
                                    'modularity': modularity,
                                    'original_nodes': len(orig), 'original_edges': orig.number_of_edges()},
                        'notice': 'Communities use NetworkX Louvain; Gephi results can differ.'})
    except (ValueError, KeyError, TypeError) as exc:
        return jsonify(error=str(exc)), 400
