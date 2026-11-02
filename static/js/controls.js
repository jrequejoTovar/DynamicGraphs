/**
 * Network Analytics Studio — application controller.
 * Entrypoint referenced by templates/index.html (type="module").
 * Imports the other JavaScript modules; no additional <script> tags needed.
 */
import { listDatasets, fetchGraph, fetchNode, requestJSON } from './api.js';
import { GraphCanvas } from './graph.js';
import { applyLayout } from './layouts.js';
import { createAIInsights } from './ai_insights.js';

const $ = id => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element in index.html: #${id}`);
  return element;
};

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const state = {
  dataset: 'bluesky',
  filters: {},
  metadata: [],
  graph: null,
  appliedLayout: null,
  aiFocus: null, // null or {nodes: string[], hops: 0|1}; UI shows this explicitly.
  // The original catalogue must not change when a subgraph is selected.
  communitiesByDataset: new Map(),
};

const layoutControls = Object.fromEntries([
  'layout', 'scaling', 'gravity', 'iterations',
  'preventOverlap', 'useWeights', 'linlog', 'strongGravity',
].map(id => [id, $(id)]));

const metricHelp = {
  degree: 'Degree counts all direct connections (incoming + outgoing). In a directed graph, a reciprocal pair contributes two edges.',
  in_degree: 'In-Degree counts distinct incoming connections: replies or mentions received in the Bluesky case. Attention is not necessarily influence.',
  out_degree: 'Out-Degree counts distinct outgoing connections: accounts a user replies to or mentions.',
  weighted_degree: 'Weighted Degree sums weights on incident edges. The dataset weights represent interaction or transaction counts.',
  weighted_in_degree: 'Weighted In-Degree sums incoming interaction counts.',
  weighted_out_degree: 'Weighted Out-Degree sums outgoing interaction counts.',
  betweenness: 'Betweenness measures structural position on shortest paths. This version uses unweighted directed paths and an approximation for graphs above 120 nodes.',
  pagerank: 'PageRank measures importance through incoming relationships from other structurally significant accounts.',
};

const graphCanvas = new GraphCanvas($('networkCanvas'), showSelectedNode);
let busy = false;
let selectionRequest = 0;
let optimizing = false;
let savedView = null;
const AI_OPTIMIZE_API = '/api/ai/optimize-view';

// AI receives only settings that Flask has already applied successfully.
const ai = createAIInsights({
  getSettings: () => currentAISettings(),
  applySuggestion: applyAISuggestion,
  log,
});

function currentAISettings() {
  return {
    dataset: state.dataset,
    filters: structuredClone(state.filters),
    size_metric: $('metric').value,
    metric_scope: $('metricScope').value,
    community_scope: $('recalcCommunities').checked ? 'filtered' : 'original',
    layout: state.appliedLayout || $('layout').value,
  };
}

async function applyAISuggestion(suggestion) {
  if (busy) return false;
  const { action, target } = suggestion;
  if (action === 'inspect_node') {
    if (!graphCanvas.byId.has(String(target))) return false;
    graphCanvas.select(String(target));
    // Explicit selection enables the separate "Interpret selected node" action.
    return true;
  }
  if (action === 'apply_giant_component') {
    $('giant').checked = true;
    return reloadGraph({ fit: true });
  }
  if (action === 'select_community') {
    const options = [...$('communitySelect').options];
    const choice = options.find(option => option.value === String(target));
    if (!choice) return false;
    options.forEach(option => { option.selected = option === choice; });
    return reloadGraph({ fit: true });
  }
  if (action === 'change_size_metric' || action === 'compare_metrics') {
    const metricSelect = $('metric');
    const option = [...metricSelect.options].find(item => item.value === target);
    if (!option) return false;
    metricSelect.value = target;
    return reloadGraph({ fit: false });
  }
  return false;
}


function log(message) {
  const row = document.createElement('div');
  row.className = 'log-item';
  row.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  $('logList').prepend(row);
  while ($('logList').children.length > 35) $('logList').lastChild.remove();
}

function setLoading(visible, text = 'Analysing network…') {
  busy = visible;
  $('loading').hidden = !visible;
  $('loadingMessage').textContent = text;
  for (const id of ['applyFilters', 'applyLayout', 'dataset', 'metric', 'metricScope']) {
    $(id).disabled = visible;
  }
}

function currentFilters() {
  return {
    giant: $('giant').checked,
    min_degree: Number($('minDegree').value),
    min_weight: Number($('minWeight').value),
    communities: Array.from($('communitySelect').selectedOptions, option => Number(option.value)),
    focus_nodes: state.aiFocus ? [...state.aiFocus.nodes] : [],
    focus_hops: state.aiFocus ? state.aiFocus.hops : 0,
  };
}

function updateSliderLabels() {
  for (const id of ['minSize', 'maxSize', 'scaling', 'gravity', 'iterations', 'minDegree']) {
    $(`${id}Value`).textContent = $(id).value;
  }
}

function selectedMetricLabel() {
  return $('metric').selectedOptions[0]?.textContent?.split(' · ')[0] ?? $('metric').value;
}

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined && text !== null) item.textContent = String(text);
  if (className) item.className = className;
  return item;
}

function renderRanking(data) {
  const list = $('ranking');
  list.replaceChildren();
  const ranking = data.rank || [];
  if (!ranking.length) {
    list.append(element('p', 'No nodes match the current filters.', 'muted'));
    return;
  }
  ranking.slice(0, 8).forEach((item, index) => {
    const row = element('div', null, 'rank-row');
    row.tabIndex = 0;
    row.role = 'button';
    row.title = item.id;
    row.append(element('span', String(index + 1).padStart(2, '0'), 'rank-n'));

    const detail = element('div', null, 'rank-details');
    detail.append(element('div', item.label, 'rank-name'));
    detail.append(element('div', item.id, 'rank-id'));
    row.append(detail);
    row.append(element('strong', fmt.format(item.value), 'rank-value'));

    row.addEventListener('click', () => graphCanvas.select(item.id));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        graphCanvas.select(item.id);
      }
    });
    list.append(row);
  });
}

function renderSummary(data) {
  state.graph = data;
  $('graphTitle').textContent =
    state.metadata.find(item => item.id === state.dataset)?.name ?? state.dataset;
  $('nodeCount').textContent = fmt.format(data.summary.nodes);
  $('edgeCount').textContent = fmt.format(data.summary.edges);
  $('communityCount').textContent = fmt.format(data.summary.communities);
  $('weakCount').textContent = fmt.format(data.summary.weak_components);
  $('rankMetric').textContent = selectedMetricLabel();
  $('metricCaption').textContent = selectedMetricLabel();
  $('colorCaption').textContent = $('colorBy').selectedOptions[0]?.textContent ?? 'Community';
  $('interpretation').textContent = metricHelp[$('metric').value] ?? '';
  renderRanking(data);
}

function populateCommunityChoices() {
  const select = $('communitySelect');
  const selected = new Set((state.filters.communities ?? []).map(String));
  let catalog = state.communitiesByDataset.get(state.dataset);

  // This only runs on a full unfiltered dataset, or if we have not cached it.
  if (!catalog) {
    const counts = new Map();
    for (const node of state.graph?.nodes ?? []) {
      counts.set(node.community, (counts.get(node.community) ?? 0) + 1);
    }
    catalog = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    state.communitiesByDataset.set(state.dataset, catalog);
  }

  select.replaceChildren();
  for (const [id, count] of catalog) {
    const option = element('option', `Community ${id} · ${count} nodes`);
    option.value = String(id);
    option.selected = selected.has(String(id));
    select.append(option);
  }
}

function emptySelection(message = 'Select a node to see its original attributes and connections.') {
  $('selection').replaceChildren(element('p', message, 'muted'));
}

function appendAttributes(container, rows, maxRows = 16) {
  const dl = document.createElement('dl');
  for (const [key, value] of rows.slice(0, maxRows)) {
    if (value == null || value === '') continue;
    dl.append(element('dt', key), element('dd', String(value)));
  }
  container.append(dl);
}

async function showSelectedNode(node) {
  const sequence = ++selectionRequest;
  // Only a node that exists in the current canvas can be investigated.
  ai.onNodeSelected(node ? { id: String(node.id), label: String(node.label ?? node.id) } : null);
  if (!node) {
    if (activeOverviewTab === 'node') selectOverviewTab('network');
    emptySelection();
    return;
  }
  // Surface the existing node-specific action immediately after selection.
  showDrawer('overview', true);
  selectOverviewTab('node');
  const box = $('selection');
  box.replaceChildren(
    element('h4', node.label),
    element('p', node.id, 'muted'),
  );
  appendAttributes(box, [
    [selectedMetricLabel(), fmt.format(node.metric)],
    ['Community', node.community],
    ...Object.entries(node.attributes ?? {}).filter(([, value]) => String(value).length < 100),
  ]);

  try {
    const info = await fetchNode(state.dataset, node.id);
    // Ignore late responses after another node or dataset was selected.
    if (sequence !== selectionRequest || graphCanvas.selected !== node.id) return;
    box.append(element('h4', 'Original graph · direct connections'));
    appendAttributes(box, [
      ['In-Degree', info.in_degree],
      ['Out-Degree', info.out_degree],
      ['Weighted Degree', fmt.format(info.weighted_degree)],
      ['Incoming (first 20)', (info.incoming ?? []).join(', ') || 'None'],
      ['Outgoing (first 20)', (info.outgoing ?? []).join(', ') || 'None'],
    ], 5);
  } catch (error) {
    if (sequence === selectionRequest) {
      box.append(element('p', `Node detail unavailable: ${error.message}`, 'micro'));
    }
  }
}

async function reloadGraph({ fit = true, refreshCatalog = false, suppressAI = false } = {}) {
  if (busy) return false;
  const payload = {
    dataset: state.dataset,
    filters: currentFilters(),
    metric: $('metric').value,
    scope: $('metricScope').value,
    recalculate_communities: $('recalcCommunities').checked,
  };
  setLoading(true, 'Calculating network metrics and filters…');
  try {
    const data = await fetchGraph(payload);
    if (!data?.nodes || !data?.edges || !data.summary) {
      throw new Error('Invalid graph payload returned by Flask.');
    }
    state.filters = payload.filters;
    // The full original-network community catalogue is created at first load.
    if (refreshCatalog) state.communitiesByDataset.delete(state.dataset);
    graphCanvas.setGraph(data.nodes, data.edges, { fit });
    graphCanvas.setSizes(Number($('minSize').value), Number($('maxSize').value));
    graphCanvas.setColors($('colorBy').value);
    graphCanvas.setHighlights(state.aiFocus?.nodes ?? []);
    $('aiFocusLegend').hidden = !state.aiFocus?.nodes?.length;
    graphCanvas.showLabels = $('showLabels').checked;
    graphCanvas.draw();
    renderSummary(data);
    populateCommunityChoices();
    if (!data.nodes.length) emptySelection('No nodes match your filters. Try a lower threshold.');
    else if (!graphCanvas.selected) emptySelection();
    log(`${data.summary.nodes} nodes · ${data.summary.edges} edges · ${$('metric').value} (${payload.scope} scope)`);
    // Commit the view only after Flask has successfully returned the graph.
    if (!suppressAI) {
      ai.onViewApplied(currentAISettings());
      syncAINodeSelection();
    }
    if (drawerVisible('controls')) afterControlsApplied();
    return true;
  } catch (error) {
    log(`ERROR · ${error.message}`);
    window.alert(error.message);
    return false;
  } finally {
    setLoading(false);
  }
}

function syncAINodeSelection() {
  const id = graphCanvas.selected == null ? null : String(graphCanvas.selected);
  const node = id ? graphCanvas.byId.get(id) : null;
  ai.onNodeSelected(node ? { id: String(node.id), label: String(node.label ?? node.id) } : null);
}

function clearFilters() {
  state.aiFocus = null;
  $('giant').checked = false;
  $('recalcCommunities').checked = false;
  $('minDegree').value = '0';
  $('minWeight').value = '0';
  for (const option of $('communitySelect').options) option.selected = false;
  updateSliderLabels();
}

// A view plan changes ONLY existing controls, filters, and layout; the
// original dataset remains unchanged on the server. The user can restore.
const AI_CONTROL_IDS = [
  'metric', 'metricScope', 'recalcCommunities', 'colorBy', 'showLabels',
  'minSize', 'maxSize', 'layout', 'scaling', 'gravity', 'iterations',
  'preventOverlap', 'useWeights', 'linlog', 'strongGravity',
  'minDegree', 'minWeight', 'giant',
];

function captureView() {
  const controls = Object.fromEntries(AI_CONTROL_IDS.map(id => {
    const item = $(id);
    return [id, item.type === 'checkbox' ? item.checked : item.value];
  }));
  return {
    dataset: state.dataset,
    controls,
    communities: [...$('communitySelect').selectedOptions].map(o => o.value),
    focus: state.aiFocus ? structuredClone(state.aiFocus) : null,
    appliedLayout: state.appliedLayout,
    positions: graphCanvas.positions(),
  };
}

function populateView(view) {
  if (!view || view.dataset !== state.dataset) {
    throw new Error('The saved view belongs to a different dataset.');
  }
  for (const [id, value] of Object.entries(view.controls)) {
    const item = $(id);
    if (item.type === 'checkbox') item.checked = Boolean(value);
    else item.value = String(value);
  }
  const selected = new Set(view.communities.map(String));
  for (const option of $('communitySelect').options) {
    option.selected = selected.has(option.value);
  }
  state.aiFocus = view.focus ? structuredClone(view.focus) : null;
  state.appliedLayout = view.appliedLayout ?? null;
  updateSliderLabels();
}

function viewFromPlan(plan) {
  const config = plan?.settings;
  if (!config || !config.filters || !config.layout_options) {
    throw new Error('AI service returned an incomplete visual plan.');
  }
  const previous = captureView();
  const controls = {
    ...previous.controls,
    metric: config.size_metric,
    metricScope: config.metric_scope,
    recalcCommunities: config.community_scope === 'filtered',
    colorBy: config.color_by,
    showLabels: Boolean(config.show_labels),
    minSize: config.min_size,
    maxSize: config.max_size,
    layout: config.layout,
    scaling: config.layout_options.scaling,
    gravity: config.layout_options.gravity,
    iterations: config.layout_options.iterations,
    preventOverlap: config.layout_options.prevent_overlap,
    useWeights: config.layout_options.use_weights,
    linlog: config.layout_options.linlog,
    strongGravity: config.layout_options.strong_gravity,
    minDegree: config.filters.min_degree,
    minWeight: config.filters.min_weight,
    giant: config.filters.giant,
  };
  const ids = (config.filters.focus_nodes ?? []).map(String);
  if (ids.length > 40 || ![0, 1].includes(config.filters.focus_hops)) {
    throw new Error('AI returned an invalid focus filter.');
  }
  return {
    dataset: state.dataset,
    controls,
    communities: (config.filters.communities ?? []).map(String),
    focus: ids.length ? { nodes: ids, hops: config.filters.focus_hops } : null,
    appliedLayout: null,
    positions: null,
  };
}

async function renderView(view, { restorePositions = false } = {}) {
  populateView(view);
  const ok = await reloadGraph({ fit: true, suppressAI: true });
  if (!ok) throw new Error('Could not load the proposed filtered network.');
  if (restorePositions && view.positions) {
    graphCanvas.setPositions(view.positions, { fit: true });
  } else if (view.controls.layout && graphCanvas.nodes.length <= 850) {
    setLoading(true, 'Optimising network layout…');
    try {
      const result = await applyLayout(state, graphCanvas, layoutControls);
      state.appliedLayout = result.layout;
    } finally {
      setLoading(false);
    }
  }
  ai.onViewApplied(currentAISettings());
  syncAINodeSelection();
}

function showPlanSummary(response) {
  const plan = response.plan;
  const effect = plan.effect;
  const focus = plan.settings.filters.focus_nodes ?? [];
  const details = [
    `${plan.title} — ${plan.reason}`,
    `Visible: ${effect.visible_nodes}/${effect.original_nodes} nodes; ` +
      `${effect.visible_edges}/${effect.original_edges} edges.`,
    `Metric: ${plan.settings.size_metric}; layout: ${plan.settings.layout}; ` +
      `focus seeds: ${focus.length}; neighbours included: ${plan.settings.filters.focus_hops === 1}.`,
    `Selected by: ${response.selected_by === 'ollama' ? 'Ollama' : 'verified rules (fallback)'}.`,
  ];
  if (response.warning) details.push(response.warning);
  details.push('Hidden nodes are not deleted. Restore the prior view at any time.');
  $('aiViewPlan').textContent = details.join('\n');
  $('aiViewPlan').hidden = false;
  $('aiRestore').hidden = false;
}

async function optimizeView() {
  if (busy || optimizing || !state.graph) return;
  optimizing = true;
  $('aiOptimize').disabled = true;
  const dataset = state.dataset;
  setLoading(true, 'Ollama is selecting a business-focused network view…');
  let response;
  try {
    response = await requestJSON(AI_OPTIMIZE_API, {
      ...currentAISettings(),
      model: $('aiModel').value,
      goal: dataset === 'transactions'
        ? 'Focus on the most material, verifiable financial anomaly for manual review'
        : 'Find the most useful structure for interpreting concentration and communities',
    }, { timeoutMs: 75_000 });
  } catch (error) {
    log(`AI visual optimisation error: ${error.message}`);
    window.alert(error.message);
    return;
  } finally {
    setLoading(false);
    optimizing = false;
    $('aiOptimize').disabled = false;
  }
  if (state.dataset !== dataset) {
    log('Ignored AI plan because the dataset changed.');
    return;
  }
  const before = captureView();
  try {
    const target = viewFromPlan(response.plan);
    await renderView(target);
    if (!savedView) savedView = before;
    showPlanSummary(response);
    log(`AI view: ${response.plan.title}; visible ${response.plan.effect.visible_nodes} nodes`);
  } catch (error) {
    // Restore both controls and the complete original visible graph.
    try { await renderView(before, { restorePositions: true }); }
    catch (restoreError) { log(`Restore error: ${restoreError.message}`); }
    log(`AI view could not be applied: ${error.message}`);
    window.alert(`AI visual optimisation could not be applied: ${error.message}`);
  }
}

async function restoreAIView() {
  if (!savedView || busy || optimizing) return;
  const previous = savedView;
  try {
    await renderView(previous, { restorePositions: true });
    savedView = null;
    $('aiRestore').hidden = true;
    $('aiViewPlan').hidden = true;
    log('Restored the network view before AI optimisation.');
  } catch (error) {
    log(`Restore view failed: ${error.message}`);
    window.alert(`Cannot restore view: ${error.message}`);
  }
}

$('aiOptimize').addEventListener('click', () => void optimizeView());
$('aiRestore').addEventListener('click', () => void restoreAIView());

async function changeDataset() {
  savedView = null;
  $('aiRestore').hidden = true;
  $('aiViewPlan').hidden = true;
  ++selectionRequest;
  ai.onNodeSelected(null);
  state.dataset = $('dataset').value;
  state.appliedLayout = null;
  clearFilters();
  state.filters = {};
  emptySelection();
  await reloadGraph({ fit: true, refreshCatalog: true });
}

async function boot() {
  setLoading(true, 'Loading available datasets…');
  let datasets;
  try {
    datasets = await listDatasets();
    if (!Array.isArray(datasets) || datasets.length === 0) {
      throw new Error('No datasets were returned.');
    }
    state.metadata = datasets;
    for (const item of datasets) {
      const option = element('option', `${item.name} · ${fmt.format(item.nodes)} nodes`);
      option.value = item.id;
      $('dataset').append(option);
    }
    state.dataset = datasets[0].id;
    $('dataset').value = state.dataset;
  } catch (error) {
    log(`Dataset error · ${error.message}`);
    window.alert(`Could not load datasets: ${error.message}`);
    return;
  } finally {
    setLoading(false);
  }
  await reloadGraph({ fit: true, refreshCatalog: true });
}

// Appearance: node sizes/colours are instantaneous — no server request.
for (const id of ['minSize', 'maxSize']) {
  $(id).addEventListener('input', () => {
    if (Number($('minSize').value) > Number($('maxSize').value)) {
      if (id === 'minSize') $('maxSize').value = $('minSize').value;
      else $('minSize').value = $('maxSize').value;
    }
    updateSliderLabels();
    graphCanvas.setSizes(Number($('minSize').value), Number($('maxSize').value));
  });
}
for (const id of ['scaling', 'gravity', 'iterations', 'minDegree']) {
  $(id).addEventListener('input', updateSliderLabels);
}
$('colorBy').addEventListener('change', () => {
  graphCanvas.setColors($('colorBy').value);
  $('colorCaption').textContent = $('colorBy').selectedOptions[0].textContent;
});
$('showLabels').addEventListener('change', () => {
  graphCanvas.showLabels = $('showLabels').checked;
  graphCanvas.draw();
});

for (const id of ['metric', 'metricScope']) {
  $(id).addEventListener('change', () => reloadGraph({ fit: false }));
}
$('dataset').addEventListener('change', changeDataset);
$('applyFilters').addEventListener('click', () => reloadGraph({ fit: true }));
$('resetFilters').addEventListener('click', () => {
  if (busy) return;
  savedView = null;
  $('aiRestore').hidden = true;
  $('aiViewPlan').hidden = true;
  clearFilters();
  reloadGraph({ fit: true });
});
$('topCommunities').addEventListener('click', () => {
  [...$('communitySelect').options].forEach((option, index) => {
    option.selected = index < 4;
  });
  log('Selected the four largest original Louvain communities. Click Apply filters.');
});
$('clearCommunities').addEventListener('click', () => {
  [...$('communitySelect').options].forEach(option => { option.selected = false; });
});

$('applyLayout').addEventListener('click', async () => {
  if (busy || !state.graph) return;
  setLoading(true, `Applying ${$('layout').value} layout…`);
  try {
    const result = await applyLayout(state, graphCanvas, layoutControls);
    state.appliedLayout = result.layout;
    log(`${result.layout} applied to ${fmt.format(result.nodes)} nodes · scaling ${$('scaling').value} · gravity ${$('gravity').value}`);
    ai.onViewApplied(currentAISettings());
    afterControlsApplied();
  } catch (error) {
    log(`Layout error · ${error.message}`);
    window.alert(error.message);
  } finally {
    setLoading(false);
  }
});

$('fitGraph').addEventListener('click', () => graphCanvas.fit());
$('zoomIn').addEventListener('click', () => graphCanvas.panZoom(1.3));
$('zoomOut').addEventListener('click', () => graphCanvas.panZoom(1 / 1.3));
$('exportImage').addEventListener('click', () => graphCanvas.savePNG());
$('clearLog').addEventListener('click', () => $('logList').replaceChildren());

/** Workspace: overlay drawers, overview tabs and contextual metric help. */
const drawers = {
  controls: {
    panel: $('controlsDrawer'),
    open: $('openControls'),
    close: $('closeControls'),
  },
  overview: {
    panel: $('overviewDrawer'),
    open: $('openOverview'),
    close: $('closeOverview'),
  },
};

function drawerVisible(name) {
  return drawers[name].panel.getAttribute('aria-hidden') !== 'true';
}

function showDrawer(name, visible, { exclusive = true } = {}) {
  const drawer = drawers[name];
  drawer.panel.setAttribute('aria-hidden', String(!visible));
  drawer.panel.inert = !visible;
  drawer.open.setAttribute('aria-expanded', String(visible));
  drawer.open.classList.toggle('is-active', visible);
  if (visible && exclusive && window.innerWidth < 1100) {
    const other = name === 'controls' ? 'overview' : 'controls';
    showDrawer(other, false, { exclusive: false });
  }
  // Recalculate the canvas presentation if a drawer transition changes the viewport.
  graphCanvas.draw();
}

for (const [name, drawer] of Object.entries(drawers)) {
  drawer.open.disabled = false;
  drawer.open.title = `Toggle ${name === 'controls' ? 'network controls' : 'network overview'}`;
  drawer.close.disabled = false;
  drawer.close.removeAttribute('title');
  drawer.open.addEventListener('click', () => showDrawer(name, !drawerVisible(name)));
  drawer.close.addEventListener('click', () => showDrawer(name, false));
}

const overviewTabs = [
  { name: 'network', tab: $('overviewNetworkTab'), panel: $('overviewNetworkPanel') },
  { name: 'ranking', tab: $('overviewRankingTab'), panel: $('overviewRankingPanel') },
  { name: 'node', tab: $('overviewNodeTab'), panel: $('overviewNodePanel') },
];
let activeOverviewTab = 'network';
function selectOverviewTab(name) {
  activeOverviewTab = name;
  for (const entry of overviewTabs) {
    const selected = entry.name === name;
    entry.tab.setAttribute('aria-selected', String(selected));
    entry.tab.tabIndex = selected ? 0 : -1;
    entry.panel.hidden = !selected;
  }
}
for (const entry of overviewTabs) {
  entry.tab.disabled = false;
  entry.tab.setAttribute('aria-controls', entry.panel.id);
  entry.tab.addEventListener('click', () => selectOverviewTab(entry.name));
  entry.tab.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = overviewTabs.findIndex(item => item.name === activeOverviewTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? overviewTabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + overviewTabs.length) % overviewTabs.length;
    selectOverviewTab(overviewTabs[next].name);
    overviewTabs[next].tab.focus();
  });
}
selectOverviewTab('network');

const pinControls = $('keepControlsOpen');
pinControls.disabled = false;
pinControls.title = 'Keep the left drawer visible after applying filters or layout.';

function afterControlsApplied(ok = true) {
  if (ok && !pinControls.checked && drawerVisible('controls')) showDrawer('controls', false);
}


const metricHelpButton = $('showMetricHelp');
metricHelpButton.disabled = false;
metricHelpButton.title = 'Show an explanation for the current node-size metric';
metricHelpButton.addEventListener('click', () => {
  selectOverviewTab('network');
  showDrawer('overview', true);
  $('metricHelpDetails').open = true;
  $('metricHelpDetails').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  // A native modal handles its own Escape; do not close underlying drawers.
  if ($('aiDetailDialog').open) return;
  if (drawerVisible('controls')) showDrawer('controls', false);
  else if (drawerVisible('overview')) showDrawer('overview', false);
});

// Start with the graph visible; users can open either overlay explicitly.
showDrawer('controls', false, { exclusive: false });
showDrawer('overview', false, { exclusive: false });

updateSliderLabels();
boot();
