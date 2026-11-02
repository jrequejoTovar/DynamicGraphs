# Network Analytics Studio — DynamicGraphs

**From network visualization to evidence-based, AI-assisted investigations**

**Author:** Jaime Requejo Tovar
**Project type:** Technical proof of concept (PoC) / educational demonstration  
**Stack:** Python · Flask · NetworkX · NumPy · SciPy · JavaScript · HTML Canvas · Ollama

> **Project status:** Experimental demonstration. Not a production-ready investigation, compliance, fraud-detection, or decision-making system.

## 1. Purpose

Network Analytics Studio (the **DynamicGraphs** project) demonstrates how graph analytics and a locally hosted large language model (LLM) can work together to help an analyst understand a network, identify relevant structural patterns, and decide what to investigate next.

The goal is **not** to have an LLM invent conclusions from a picture. Instead, the application follows an evidence-led workflow:

1. Load a real graph representation from a local dataset.
2. Calculate graph measures and relationships in Python using NetworkX.
3. Explore the network interactively through metrics, layouts, filters, communities, and node inspection.
4. Build a compact, server-verified analytical snapshot of the current graph.
5. Ask a local LLM to interpret the evidence, distinguish observations from hypotheses, and suggest a next investigative step.
6. Allow the analyst to review and apply supported changes to the view, then re-examine the results.

The PoC is intended to make this process understandable and reproducible. It also shows where additional engineering, controls, and domain knowledge would be needed for a production deployment.

## 2. What the application demonstrates

### Interactive network exploration

- Visualize directed graphs in an interactive, browser-based HTML Canvas.
- Zoom, pan, select nodes, inspect attributes and direct connections, and export the current view as a PNG.
- Size nodes using **degree, in-degree, out-degree, weighted degree, weighted in-degree, weighted out-degree, betweenness**, or **PageRank**.
- Color nodes by **Louvain community**, category, or a uniform color.
- Compare centrality calculated on the **original network** with centrality calculated on the **filtered network**.
- Apply **ForceAtlas2 (NetworkX)**, circular, grid, or random layouts.
- Filter by minimum edge weight, minimum degree, original community, or largest weakly connected component.
- Recalculate community membership on a filtered view when required.

### AI Network Analyst

The AI layer uses **Ollama** to interpret graph evidence calculated on the server. Its main functions are:

- **Analyse network:** interpret the current network or filtered view.
- **Analyse this node:** examine a selected node and its one-hop neighborhood.
- **Next investigation:** suggest a supported metric change, community selection, giant-component filter, or node inspection. Applying these suggestions requires user approval in the interface.
- **Optimise & focus:** select a business-oriented view from a set of verified candidate configurations. This is a user-triggered action, can use a rule-based fallback if Ollama cannot select a candidate, and can be reversed with **Restore view**.
- **Compare views:** explain meaningful differences between the current and previous graph settings where applicable.

Interpretations are presented as a **five-stage investigation workflow**:

| Stage | Question |
|---|---|
| 1. Observation | What are we seeing? |
| 2. Business meaning | Why might it matter? |
| 3. Evidence | Which verified facts support the interpretation? |
| 4. Next investigation | What should we examine next? |
| 5. Business action | What action, if any, is justified by the available evidence? |

The model receives a compact graph snapshot with calculated facts and allowed actions, **not the entire raw edge and node dataset**. The backend validates returned fact identifiers and supported actions. A structured-output fallback can provide a clearly labeled, rule-based summary when the model does not produce usable JSON.

**Important:** These controls reduce unsupported output; they do not guarantee the correctness of every interpretation or make the application suitable for automated decisions.

## 3. Included datasets

The ZIP contains two active, directed network datasets:

| Dataset ID | Source files | Nodes | Edges | Meaning |
|---|---|---:|---:|---|
| `bluesky` | `data/bluesky_v5/social_v5.gexf` | 2,949 | 3,445 | Observed Bluesky replies and explicit mentions between accounts |
| `transactions` | `data/transactions/nodes.csv` and `edges.csv` | 180 | 660 | Aggregated directed relationships between financial accounts |

The counts above were checked against the supplied files.

### Bluesky network

Nodes represent Bluesky accounts. Directed edges represent observed replies or explicit mentions; edge weight represents the number of observed interactions. This is a **sample**, not a complete or representative census of Bluesky activity. Network centrality does not prove influence, endorsement, agreement, or any particular intent.

### Financial transactions network

Nodes represent accounts. Directed edges represent aggregated sender-to-recipient relationships. The edge **`weight` is `Transaction_Count`**, not the monetary amount. The separate `Total_Amount_EUR` attribute represents the aggregate amount recorded on a relationship.

The application can highlight structural patterns, including directed cycles and groups with high aggregate amounts, for **manual review**. Because the source is aggregated, it does not establish transaction sequence, fund circulation, ownership, criminal intent, or fraud. These findings are screening leads, not accusations or risk probabilities.

## 4. Architecture

```text
                      Browser
                         |
                         | HTTP / JSON
                         v
                 Flask web application
                    (127.0.0.1:5050)
                         |
             +-----------+-----------+
             |                       |
             v                       v
      NetworkX services       AI interpretation
      - load datasets         - verified snapshots
      - graph filters         - business patterns
      - centrality            - evidence checks
      - communities           - suggested actions
      - layouts                      |
             |                       | HTTP /api/chat
             v                       v
      Local GEXF / CSV          Ollama server
      graph datasets           (127.0.0.1:11434)
                                      |
                                      v
                                  Local LLM
```

The browser uses JavaScript modules and a native Canvas 2D renderer. Flask provides the JSON API, NetworkX performs graph calculations, and the AI services communicate with Ollama using Python's standard HTTP library.

**This project does not use PostgreSQL, MCP, Apache Superset, or Docker.** Those are components of a different application and are not required to run DynamicGraphs.

## 5. Requirements

| Component | Requirement |
|---|---|
| Operating system | macOS, Linux, or Windows with a suitable Python environment |
| Python | Python **3.12 recommended**; a compatible modern Python version is required |
| Python packages | Listed in `requirements.txt` |
| Browser | Modern browser supporting JavaScript modules, Canvas 2D, `ResizeObserver`, and native dialogs |
| Ollama | Required for LLM interpretations; not required for ordinary graph exploration |
| Default model | `qwen3:8b` |
| Network access | Loopback access to Flask and Ollama; internet is not needed for graph exploration once dependencies and models are installed |

The provided `requirements.txt` specifies:

```text
Flask>=3.0,<4
networkx>=3.4,<4
numpy>=1.26
scipy>=1.11
```

NetworkX 3.4 or newer is important because this implementation uses `networkx.forceatlas2_layout`.

LLM performance depends on available CPU/GPU resources and memory. Larger models may require significantly more RAM and longer response times.

## 6. Installation

### 6.1 Extract the ZIP

```bash
unzip 'DynamicGraphs 2.zip'
cd DynamicGraphs
```

If the project is already extracted, open a terminal in the directory containing `app.py` and `requirements.txt`.

### 6.2 Create a Python virtual environment

On macOS or Linux:

```bash
python3 --version
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

The `.venv/` directory is a local, reconstructible environment. It should not be committed to Git.

### 6.3 Start the Flask application

From the project root, with the virtual environment activated, load the project `.env` file into the shell environment and then start Flask:

```bash
set -a
source .env
set +a
python3 app.py
```

The `.env` file is expected to be located alongside `app.py` and `requirements.txt`. The supplied Python code reads `OLLAMA_BASE_URL` from the process environment; loading the file in the shell ensures that the value reaches Flask without requiring changes to the application code.

Open **http://127.0.0.1:5050** in your browser.

The supplied `app.py` binds to `127.0.0.1`, uses port **5050**, and starts Flask in **debug mode**. These settings are intended for local development only.

Graph visualization, filters, metrics, node inspection, and PNG export can work **without Ollama**. AI interpretation requires the additional steps below.

## 7. Ollama setup

### 7.1 Install and start Ollama

Install Ollama from <https://ollama.com/download>.

If it is not already running as a background service, start it:

```bash
ollama serve
```

Do not start a second Ollama instance if one is already listening on port `11434`.

### 7.2 Download the default model

```bash
ollama pull qwen3:8b
ollama list
```

Check the local API:

```bash
curl http://127.0.0.1:11434/api/tags
```

### 7.3 Configure Ollama using `.env`

The project uses a root-level `.env` file to specify the Ollama endpoint. The current local configuration is:

```dotenv
# Ollama API endpoint
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

The application reads the environment variable `OLLAMA_BASE_URL` and uses `http://127.0.0.1:11434` as its fallback when the variable is not set.

**Important:** In the supplied ZIP, the Python code reads environment variables but does **not** automatically parse `.env` files. To apply the value from `.env`, run the following commands in the project root before starting Flask:

```bash
set -a
source .env
set +a
python3 app.py
```

You can check the loaded value with:

```bash
printf '%s\n' "$OLLAMA_BASE_URL"
```

If you have subsequently added `python-dotenv` loading to your Python startup code, sourcing `.env` manually is optional. The commands above remain compatible with that setup.

For a remote Ollama instance, change only the `.env` value, for example:

```dotenv
OLLAMA_BASE_URL=http://ollama-host.example.internal:11434
```

The remote server must be reachable from the Flask machine, and access should be protected using appropriate network security controls.

Do not commit your local `.env` file to Git. If sharing the project, publish a safe `.env.example` containing non-sensitive example values instead.

### 7.4 Available models

The application currently permits these model identifiers in `services/ai_interpreter.py`:

```text
qwen3:8b
mistral-nemo:latest
mixtral:latest
```

The default is `qwen3:8b`. The model selection list is an application allowlist, **not a live list of models installed in Ollama**. To use another allowed model, download it with `ollama pull <model-name>` first.

The default model and allowlist are currently defined in Python, not by an `OLLAMA_DEFAULT_MODEL` environment variable. If you want those settings to be configurable, that would require a code change.

## 8. Using the application

### 8.1 Explore a network

1. Open the application at `http://127.0.0.1:5050`.
2. Choose **Bluesky V5 · User Interactions** or **Suspicious Transactions · Accounts**.
3. Select a node size metric and color encoding.
4. Use **Controls** to apply filters, select communities, or choose a layout.
5. Use **Overview** to inspect network statistics, rankings, and individual nodes.
6. Use the canvas controls to zoom, fit the graph, or export the view as PNG.

**ForceAtlas2 limitation:** The backend limits ForceAtlas2 to **850 visible nodes** and a maximum of **150 iterations**. The Bluesky dataset has 2,949 nodes, so filter it before requesting ForceAtlas2, or use a different layout.

### 8.2 Analyse the network with AI

1. Make sure Ollama is running and the selected model is installed.
2. Choose the dataset and the graph view you want to interpret.
3. Click **Analyse network** (or choose automatic analysis after applying changes).
4. Read the five-stage workflow: Observation → Business meaning → Evidence → Next investigation → Business action.
5. Open a stage to review the detailed interpretation and supporting evidence.
6. Review any proposed next investigation before approving a change to the graph view.

### 8.3 Investigate a node

Select a node in the graph or the rankings and click **Analyse this node**. The backend reconstructs a verified **one-hop neighborhood** around that node in the current filtered graph. This is a local investigation, not a claim about the entire original dataset.

### 8.4 Optimise and focus

Click **Optimise & focus** to request a focused, evidence-based visualization plan. The application constructs candidate views using verified graph information; Ollama may choose among them. If model selection is unavailable, the application can fall back to a deterministic candidate. This button **applies the selected view as part of the user-requested operation**; use **Restore view** to return to the prior configuration.

## 9. Validation and smoke tests

**No dedicated automated `test/` directory or test suite is included in the supplied ZIP.** The following checks use the application's existing endpoints and local datasets.

### 9.1 Validate the Python files

From the project root:

```bash
python3 -m compileall -q app.py routes services
```

### 9.2 Check Flask health

With Flask running:

```bash
curl -fsS http://127.0.0.1:5050/health
```

Expected JSON:

```json
{"status":"ok"}
```

### 9.3 Check the dataset catalog

```bash
curl -fsS http://127.0.0.1:5050/api/datasets | python3 -m json.tool
```

The response should include `bluesky` and `transactions` with the node and edge counts listed above.

### 9.4 Check graph calculations

```bash
curl -fsS -X POST http://127.0.0.1:5050/api/graph \
  -H 'Content-Type: application/json' \
  -d '{"dataset":"transactions","metric":"in_degree","filters":{}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["summary"])'
```

The unfiltered transaction network should report **180 nodes** and **660 edges**.

### 9.5 Check node inspection

```bash
curl -fsS -X POST http://127.0.0.1:5050/api/node \
  -H 'Content-Type: application/json' \
  -d '{"dataset":"transactions","id":"A018"}' \
  | python3 -m json.tool
```

The response should contain node attributes and incoming/outgoing neighbors.

### 9.6 Check AI model configuration

```bash
curl -fsS http://127.0.0.1:5050/api/ai/models | python3 -m json.tool
```

This checks the application's allowed model list; it **does not verify** that Ollama is running or that a model is installed. Check the Ollama API separately using `/api/tags`.

### 9.7 End-to-end AI validation

With Ollama running and `qwen3:8b` installed, use the browser's **Analyse network** and **Analyse this node** actions. Verify that the five-stage interpretation appears and that any fallback or error is clearly reported.

These are functional smoke tests, not comprehensive tests of analytical accuracy, privacy, security, or performance.

## 10. Main API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Flask health response |
| GET | `/api/datasets` | Available datasets and dimensions |
| POST | `/api/graph` | Filtered graph, metrics, rankings, and initial positions |
| POST | `/api/layout` | Compute a selected graph layout |
| POST | `/api/node` | Inspect original attributes and direct neighbors of a node |
| GET | `/api/ai/models` | Configured model allowlist |
| POST | `/api/ai/interpret` | Interpret a verified network snapshot |
| POST | `/api/ai/interpret-node` | Interpret a verified one-hop node neighborhood |
| POST | `/api/ai/optimize-view` | Produce a focused graph-view plan |

The API is intended for the local demonstration. It does not implement a public, authenticated service contract.

## 11. Project structure

```text
DynamicGraphs/
├── app.py                        # Flask entry point, port 5050
├── requirements.txt              # Python dependencies
├── data/
│   ├── bluesky_v5/
│   │   └── social_v5.gexf
│   └── transactions/
│       ├── nodes.csv
│       └── edges.csv
├── routes/
│   ├── graph_routes.py           # Dataset and graph APIs
│   ├── analysis_routes.py        # Layout and node inspection
│   └── ai_routes.py              # AI interpretation and view planning
├── services/
│   ├── graph_loader.py           # Read GEXF and CSV graphs
│   ├── filters.py                # Reversible graph filters
│   ├── centrality.py             # Degree, betweenness, PageRank
│   ├── communities.py            # Louvain communities
│   ├── layouts.py                # ForceAtlas2 and other layouts
│   ├── graph_snapshot.py         # Server-verified graph summaries
│   ├── business_patterns.py      # Financial screening patterns
│   ├── ai_interpreter.py         # Ollama interpretation and validation
│   └── view_optimizer.py         # Verified candidate visualization plans
├── templates/
│   └── index.html                # Main interface
└── static/
    ├── css/style.css
    └── js/
        ├── api.js
        ├── graph.js
        ├── layouts.js
        ├── controls.js
        └── ai_insights.js
```

The ZIP also includes backup Python modules (`*_bck.py`), `__pycache__` folders, and macOS metadata files. They are not required for normal execution and should generally be excluded from a clean public repository.

## 12. Scope, limitations, and production requirements

This PoC deliberately prioritizes the **analytical process**: how an analyst can move from a visual network to verified measures, an AI interpretation, and a testable next investigation.

It is **not** a general graph analytics platform, an automated fraud detector, a compliance engine, or a production-ready AI application.

A production implementation would require further work in areas such as:

| Area | Additional engineering or controls |
|---|---|
| Authentication and authorization | Identity integration, user roles, session management, dataset-level access control |
| Data security and privacy | PII handling, data minimization, access restrictions, encryption, retention rules |
| Governance and auditing | Audit trails for datasets, prompts, graph operations, LLM calls, and user actions |
| Data provenance | Documented dataset sources, ownership, quality checks, lineage, and update processes |
| Metadata and semantics | Stronger graph schemas, relationship definitions, domain-specific business semantics |
| LLM reliability | Structured-output evaluation, hallucination testing, error analysis, human review |
| Model operations | Token/context monitoring, latency and resource controls, model version management |
| Analytical validity | Domain validation, false-positive assessment, bias checks, reproducible methodologies |
| Visualization | Additional chart types, large-graph rendering, accessibility, performance optimization |
| Operational robustness | Logging, monitoring, tests, deployment automation, scaling, exception handling |
| Application security | Hardened HTTP service, disabled debug mode, request limits, secure remote Ollama access |

### Important analytical limitations

- The Bluesky graph is sampled; absence of an edge is not evidence that an interaction never occurred.
- Weak connectivity does not mean strong connectivity.
- Louvain communities are structural groupings, not proof of common opinions or coordination.
- Betweenness uses unweighted directed shortest paths and is **approximated for graphs above 120 nodes** using a reproducible 120-node sample.
- Financial edges aggregate transactions; topology alone cannot reconstruct chronological fund flows or prove misconduct.
- LLM outputs may be incorrect or incomplete, even when based on verified graph statistics.
- The Flask development server runs with `debug=True` and is **not suitable for public exposure**.

All investigative findings should be treated as hypotheses or review priorities until validated against appropriate underlying evidence.

## 13. Troubleshooting

| Symptom | What to check |
|---|---|
| `ModuleNotFoundError: flask` or `networkx` | Activate `.venv` and run `python -m pip install -r requirements.txt` |
| Port 5050 is already in use | Stop the conflicting process or change the port in `app.py` |
| No graph is displayed | Check the Flask terminal, browser developer console, and `/api/datasets` response |
| Dataset file not found | Start the project with its `data/` directory intact |
| ForceAtlas2 refuses a layout | Filter the visible graph to 850 nodes or fewer, or choose a different layout |
| AI cannot contact Ollama | Start Ollama and check `OLLAMA_BASE_URL` and port `11434` |
| Ollama reports model not found | Run `ollama list`, then `ollama pull qwen3:8b` if necessary |
| AI interpretation is slow | Check hardware resources; use a smaller graph/view or a compatible lighter model |
| AI output is a verified fallback | The model failed to produce valid structured JSON; review Ollama/model compatibility and logs |
| Model appears in UI but fails | The application lists allowed models, not necessarily installed models |
| A graph view changes after optimization | Use **Restore view** to return to the previous configuration |

## 14. Publishing on GitHub

Before making the repository public:

1. Review dataset provenance and whether the Bluesky account information and financial example data may be redistributed.
2. Remove secrets, internal endpoints, credentials, and personal information that should not be public.
3. Exclude local environments, caches, and macOS metadata from version control.
4. Review backup files before publication.
5. Decide on a license for your original code and retain third-party copyright/license notices.

Suggested `.gitignore`:

```gitignore
.venv/
venv/
__pycache__/
*.py[cod]
.DS_Store
__MACOSX/
.env
*.log
```

The supplied ZIP does **not** contain a project license file. Do not assume that making a repository public automatically grants permission to reuse its original code. Choose a license explicitly if you intend to grant such rights.

**Suggested GitHub description:**

> Proof of concept combining interactive graph analytics, NetworkX, and local LLMs through Ollama to support evidence-based network interpretation and AI-assisted investigations.

**Suggested topics:** `graph-analytics`, `networkx`, `ollama`, `llm`, `flask`, `network-visualization`, `ai-investigation`, `proof-of-concept`

## 15. Author and acknowledgements

**Concept, application development, and integration:** Jaime Requejo

Network Analytics Studio was developed to demonstrate how graph analytics and AI can support a disciplined investigative workflow: **observe → measure → interpret → verify → investigate**.

The project builds on third-party technologies, including Flask, NetworkX, NumPy, SciPy, and Ollama. Authorship attribution refers to the original application and integration work, not to those third-party projects or their respective intellectual property.

**Status: Technical Proof of Concept — Not Production Ready.**
