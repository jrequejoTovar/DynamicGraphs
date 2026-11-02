
"""Load real network datasets for Network Analytics Studio."""

import csv
from functools import lru_cache
from pathlib import Path

import networkx as nx


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"

DATASETS = {
    "bluesky": {
        "name": "Bluesky V5 · User Interactions",
        "kind": "social",
        "directed": True
    },
    "transactions": {
        "name": "Suspicious Transactions · Accounts",
        "kind": "financial",
        "directed": True
    }
}


def convert_value(value):
    """Convert numeric CSV values while preserving text."""
    if value is None or value == "":
        return ""

    try:
        return float(value) if "." in str(value) else int(value)
    except (ValueError, TypeError):
        return str(value)


@lru_cache(maxsize=4)
def load_graph(dataset: str) -> nx.DiGraph:
    """Load a dataset and return a directed NetworkX graph."""

    if dataset == "bluesky":
        path = DATA_DIR / "bluesky_v5" / "social_v5.gexf"

        graph = nx.read_gexf(path)
        g = nx.DiGraph(graph)

        for node, attributes in g.nodes(data=True):
            attributes["label"] = (
                attributes.get("display_name")
                or attributes.get("handle")
                or str(node)
            )
            attributes["category"] = "Bluesky account"

        for _, _, attributes in g.edges(data=True):
            attributes["weight"] = float(
                attributes.get("weight", 1) or 1
            )

    elif dataset == "transactions":
        g = nx.DiGraph()

        nodes_path = DATA_DIR / "transactions" / "nodes.csv"
        edges_path = DATA_DIR / "transactions" / "edges.csv"

        # Load accounts
        with nodes_path.open(
            encoding="utf-8-sig", newline=""
        ) as file:
            for row in csv.DictReader(file):
                node_id = row.pop("Id")

                g.add_node(
                    node_id,
                    label=node_id,
                    category=row.get("Account_Type", "Account"),
                    **{
                        key: convert_value(value)
                        for key, value in row.items()
                    }
                )

        # Load financial relationships
        with edges_path.open(
            encoding="utf-8-sig", newline=""
        ) as file:
            for row in csv.DictReader(file):
                source = row.pop("Source")
                target = row.pop("Target")

                attributes = {
                    key: convert_value(value)
                    for key, value in row.items()
                }

                attributes["weight"] = float(
                    attributes["Transaction_Count"]
                )

                g.add_edge(
                    source,
                    target,
                    **attributes
                )

    else:
        raise ValueError(f"Unknown dataset: {dataset}")

    return g


def dataset_list():
    """Return the available datasets and their dimensions."""

    return [
        {
            "id": dataset_id,
            **metadata,
            "nodes": load_graph(dataset_id).number_of_nodes(),
            "edges": load_graph(dataset_id).number_of_edges()
        }
        for dataset_id, metadata in DATASETS.items()
    ]
