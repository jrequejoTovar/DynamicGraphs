/**
 * AI Network Analyst — UI adapter for the local Flask + Ollama API.
 *
 * No model-generated JavaScript is ever executed. Network operations are
 * explicitly whitelisted and performed by the existing app controller.
 * Import and initialize from controls.js; this module does not own the graph.
 */
import { requestJSON } from './api.js';

const API_MODELS = '/api/ai/models';
const API_INTERPRET = '/api/ai/interpret';
const API_INTERPRET_NODE = '/api/ai/interpret-node';
const SUPPORTED_ACTIONS = new Set([
  'change_size_metric', 'compare_metrics', 'apply_giant_component',
  'select_community', 'inspect_node',
]);

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const el = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
};

function subsection(title, contents) {
  const section = el('section', null, 'ai-section');
  section.appendChild(el('h4', title));
  if (contents != null && String(contents).trim()) {
    section.appendChild(el('p', contents));
  }
  return section;
}

function validSuggestedAction(next) {
  return next && typeof next.action === 'string'
    && SUPPORTED_ACTIONS.has(next.action);
}

/**
 * @param {Object} opts
 * @param {() => Object} opts.getSettings Return only committed settings.
 * @param {(action: {action:string,target:string}) => Promise<boolean>} opts.applySuggestion
 * @param {(message: string) => void} [opts.log]
 */
export function createAIInsights({ getSettings, applySuggestion, log = () => {} }) {
  const root = $('aiAnalyst');
  if (!root) {
    // The optional HTML partial hasn't been inserted yet. Existing UI remains usable.
    return { onViewApplied() {}, onNodeSelected() {}, analyze() {}, interpretNode() {}, destroy() {} };
  }

  const modelSelect = $('aiModel');
  const modeSelect = $('aiMode');
  const analyzeButton = $('aiAnalyze');
  const status = $('aiStatus');
  const content = $('aiResult');
  const required = [modelSelect, modeSelect, analyzeButton, status, content];
  if (required.some((item) => !item)) {
    throw new Error('AI panel markup is incomplete; see integration/ai_panel.html.');
  }

  // Use the existing Selected node action inside Network Overview.
  // Do not generate a duplicate button in the top AI toolbar.
  const nodeButton = $('aiAnalyseNode') ?? $('aiInterpretNode');
  if (nodeButton) {
    nodeButton.type = 'button';
    nodeButton.disabled = true;
    nodeButton.title = 'Select a node in the graph to enable interpretation.';
  }

  const stageSpecs = [
    { key: 'observation', button: 'workflowObservation', summary: 'workflowObservationSummary', title: '01 · Observation', placeholder: 'What are we seeing?' },
    { key: 'meaning', button: 'workflowMeaning', summary: 'workflowMeaningSummary', title: '02 · Business meaning', placeholder: 'Why does it matter?' },
    { key: 'evidence', button: 'workflowEvidence', summary: 'workflowEvidenceSummary', title: '03 · Supporting evidence', placeholder: 'Which facts support it?' },
    { key: 'investigation', button: 'workflowInvestigation', summary: 'workflowInvestigationSummary', title: '04 · Next investigation', placeholder: 'What should we examine?' },
    { key: 'action', button: 'workflowAction', summary: 'workflowActionSummary', title: '05 · Business action', placeholder: 'What decision is justified?' },
  ];
  const workflow = {
    freshness: $('workflowFreshness'),
    networkTab: $('networkAnalysisTab'),
    nodeTab: $('nodeAnalysisTab'),
    dialog: $('aiDetailDialog'),
    dialogTitle: $('aiDetailTitle'),
    dialogContent: $('aiDetailContent'),
    dialogActions: $('aiDetailActions'),
    close: $('closeAiDetail'),
    cards: stageSpecs.map(spec => ({ ...spec, button: $(spec.button), summary: $(spec.summary) })),
  };
  let activeMode = 'network';
  const results = { network: null, node: null };

  function updateFreshness(message, state = '') {
    if (!workflow.freshness) return;
    workflow.freshness.textContent = message;
    workflow.freshness.dataset.state = state;
  }

  function short(text, fallback) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value ? (value.length > 105 ? `${value.slice(0, 102)}…` : value) : fallback;
  }

  function setActiveMode(mode) {
    if (!['network', 'node'].includes(mode)) return;
    activeMode = mode;
    const cached = results[mode];
    if (cached) render(cached.response, cached.response.snapshot, cached.node);
    else showPlaceholder(mode === 'node'
      ? 'Select a node and choose Analyse this node to create a node interpretation.'
      : 'Choose Analyse network to interpret the current view.');
    for (const [tab, which] of [[workflow.networkTab, 'network'], [workflow.nodeTab, 'node']]) {
      if (!tab) continue;
      tab.classList.toggle('active', which === mode);
      tab.setAttribute('aria-pressed', String(which === mode));
    }
    paintWorkflow();
  }

  function paintWorkflow() {
    const result = results[activeMode];
    const interpretation = result?.response?.interpretation;
    const next = interpretation?.next_investigation ?? {};
    const action = interpretation?.business_action ?? {};
    const evidence = Array.isArray(interpretation?.evidence) ? interpretation.evidence : [];
    const values = interpretation ? [
      short(interpretation.what_we_see, 'No observation supplied.'),
      short(interpretation.business_meaning, 'No business meaning supplied.'),
      evidence.length ? short(`${evidence.length} verified evidence item(s)`, 'No evidence listed.') : 'No evidence listed.',
      short(next.reason, 'No further investigation suggested.'),
      short(action.recommended && action.proposal ? action.proposal : 'Not yet justified by the available evidence.', 'No action proposed.'),
    ] : [];
    workflow.cards.forEach((stage, i) => {
      if (!stage.button || !stage.summary) return;
      stage.button.disabled = !interpretation;
      stage.button.classList.remove('is-active');
      stage.summary.textContent = interpretation ? values[i] : stage.placeholder;
      stage.button.title = interpretation ? values[i] : 'Run an AI interpretation to enable this step.';
    });
    if (!interpretation) {
      const ready = activeMode === 'node'
        ? (selectedNode ? `Selected: ${short(selectedNode.label, selectedNode.id)} · Run node analysis` : 'Select a node to investigate')
        : 'Run network analysis to populate the five stages';
      updateFreshness(ready, '');
    } else {
      const heading = activeMode === 'node' ? `Node: ${short(result.node?.label, 'selected node')}` : 'Network analysis';
      updateFreshness(interpretation.warning ? `${heading} · Verified-only fallback` : `${heading} · Ready`, interpretation.warning ? 'error' : 'success');
    }
  }

  const confirmUI = {
    dialog: $('aiConfirmDialog'),
    action: $('aiConfirmAction'),
    target: $('aiConfirmTarget'),
    reason: $('aiConfirmReason'),
    learningRow: $('aiConfirmLearningRow'),
    learning: $('aiConfirmLearning'),
    approve: $('aiConfirmApprove'),
    cancel: $('aiConfirmCancel'),
  };
  const progressUI = {
    dialog: $('aiProgressDialog'),
    title: $('aiProgressTitle'),
    description: $('aiProgressDescription'),
    context: $('aiProgressContext'),
    elapsed: $('aiProgressElapsed'),
    state: $('aiProgressState'),
    activity: $('aiProgressActivity'),
    bar: $('aiProgressBar'),
    error: $('aiProgressError'),
    cancel: $('aiProgressCancel'),
  };
  let pendingApproval = null;
  let progressTimer = null;
  let progressState = 'idle';

  const suggestionLabels = {
    inspect_node: 'Inspect suggested node',
    apply_giant_component: 'Focus on largest connected component',
    select_community: 'Focus on suggested community',
    change_size_metric: 'Change node-size metric',
    compare_metrics: 'Compare centrality metrics',
  };

  function confirmSuggestion(next) {
    const ui = confirmUI;
    if (!ui.dialog || typeof ui.dialog.showModal !== 'function') {
      setStatus('Investigation confirmation dialog is unavailable.', 'error');
      return Promise.resolve(false); // Never apply a suggestion without explicit consent.
    }
    if (pendingApproval) return Promise.resolve(false);
    ui.action.textContent = suggestionLabels[next.action] || 'Update graph view';
    ui.target.textContent = String(next.target ?? '').trim() || 'Current network view';
    ui.reason.textContent = String(next.reason || 'Examine the suggested pattern using the selected action.');
    const learning = String(next.expected_learning || '').trim();
    ui.learningRow.hidden = !learning;
    ui.learning.textContent = learning;
    ui.dialog.returnValue = '';
    return new Promise(resolve => {
      pendingApproval = resolve;
      ui.dialog.showModal();
      ui.cancel?.focus();
    });
  }

  function resolveApproval(approved) {
    const resolve = pendingApproval;
    pendingApproval = null;
    if (confirmUI.dialog?.open) confirmUI.dialog.close();
    if (resolve) resolve(Boolean(approved));
  }
  confirmUI.cancel?.addEventListener('click', () => resolveApproval(false));
  confirmUI.approve?.addEventListener('click', () => resolveApproval(true));
  confirmUI.dialog?.addEventListener('close', () => {
    if (pendingApproval) resolveApproval(false); // Escape or system close means no.
  });
  confirmUI.dialog?.addEventListener('click', event => {
    if (event.target === confirmUI.dialog) resolveApproval(false);
  });

  function stopProgressClock() {
    if (progressTimer !== null) clearInterval(progressTimer);
    progressTimer = null;
  }
  function closeProgress() {
    stopProgressClock();
    progressState = 'idle';
    if (progressUI.dialog?.open) progressUI.dialog.close();
  }
  function startProgress(kind, node = null) {
    const ui = progressUI;
    if (!ui.dialog || typeof ui.dialog.showModal !== 'function') return;
    closeProgress();
    ui.title.textContent = kind === 'node' ? 'Analysing selected node' : 'Analysing network';
    ui.description.textContent = kind === 'node'
      ? 'Verifying this node’s relationships and requesting an interpretation from the local model.'
      : 'Preparing a verified graph snapshot and requesting an interpretation from the local model.';
    const dataset = current?.dataset === 'transactions' ? 'Transactions' : current?.dataset === 'bluesky' ? 'Bluesky' : (current?.dataset || 'Network');
    ui.context.textContent = `${dataset} · ${kind === 'node' ? short(node?.label, node?.id) : 'Entire visible network'} · ${modelSelect.value}`;
    ui.state.textContent = 'Analysis in progress';
    ui.error.hidden = true;
    ui.error.textContent = '';
    ui.activity.classList.remove('is-error');
    ui.bar.hidden = false;
    ui.cancel.textContent = 'Cancel analysis';
    ui.dialog.returnValue = '';
    progressState = 'running';
    const began = Date.now();
    const tick = () => { ui.elapsed.textContent = `${Math.floor((Date.now() - began) / 1000)}s elapsed`; };
    tick();
    progressTimer = setInterval(tick, 1000);
    ui.dialog.showModal();
    ui.cancel.focus();
  }
  function showProgressError(error) {
    const ui = progressUI;
    if (!ui.dialog?.open) return;
    stopProgressClock();
    progressState = 'error';
    ui.title.textContent = 'Unable to complete analysis';
    ui.description.textContent = 'The analysis could not finish. Your graph view has not been changed.';
    ui.state.textContent = 'Request failed';
    ui.activity.classList.add('is-error');
    ui.bar.hidden = true;
    ui.error.textContent = String(error || 'Unknown error');
    ui.error.hidden = false;
    ui.cancel.textContent = 'Close';
    ui.cancel.focus();
  }
  function cancelProgress() {
    if (progressState === 'running') {
      clearRequest(); // Invalidates any late model response and aborts the fetch.
      setStatus('AI analysis cancelled.', '');
      updateFreshness('Analysis cancelled', '');
      log('AI analysis cancelled by user');
    }
    closeProgress();
  }
  progressUI.cancel?.addEventListener('click', cancelProgress);
  progressUI.dialog?.addEventListener('cancel', event => {
    event.preventDefault();
    cancelProgress();
  });
  progressUI.dialog?.addEventListener('click', event => {
    if (event.target === progressUI.dialog) cancelProgress();
  });

  async function executeSuggestion(next, button) {
    if (running || disposed || !validSuggestedAction(next)) return;
    if (!await confirmSuggestion(next)) return;
    if (running || disposed) return;
    button.disabled = true;
    try {
      const applied = await applySuggestion({ action: next.action, target: String(next.target ?? '') });
      if (applied === false) setStatus('This investigation is not available in the current view.', 'error');
      else {
        log(`AI suggested action applied: ${next.action}`);
        if (workflow.dialog?.open) workflow.dialog.close();
        setStatus('Suggested investigation applied to the network view.', 'success');
      }
    } catch (error) {
      setStatus(`Could not apply investigation: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function suggestedActionButton(next) {
    if (!validSuggestedAction(next)) return null;
    const button = el('button', suggestionLabels[next.action] || 'Apply suggested investigation', 'ai-action-button');
    button.type = 'button';
    button.addEventListener('click', () => { void executeSuggestion(next, button); });
    return button;
  }

  function openStage(key) {
    const result = results[activeMode];
    const interpretation = result?.response?.interpretation;
    if (!interpretation || !workflow.dialog || typeof workflow.dialog.showModal !== 'function') return;
    const stage = workflow.cards.find(item => item.key === key);
    if (!stage) return;
    workflow.dialogTitle.textContent = stage.title + (activeMode === 'node' ? ` · ${result.node?.label ?? ''}` : '');
    const next = interpretation.next_investigation ?? {};
    const action = interpretation.business_action ?? {};
    const detail = workflow.dialogContent;
    const actions = workflow.dialogActions;
    detail.replaceChildren();
    actions.replaceChildren();
    if (interpretation.warning) detail.append(el('p', interpretation.warning, 'ai-caution'));
    if (key === 'observation') {
      detail.append(el('p', interpretation.what_we_see || 'No observation supplied.'));
      if (result.node && result.response.selected_node) {
        const n = result.response.selected_node;
        detail.append(el('p', `Selected node ${result.node.label} (${result.node.id}). In/Out degree: ${n.in_degree}/${n.out_degree}; direct neighbours: ${n.direct_neighbours}; one-hop network: ${n.local_nodes} nodes and ${n.local_edges} edges.`, 'ai-secondary'));
      }
    } else if (key === 'meaning') {
      detail.append(el('p', interpretation.business_meaning || 'No business meaning supplied.'));
    } else if (key === 'evidence') {
      const evidence = Array.isArray(interpretation.evidence) ? interpretation.evidence : [];
      if (!evidence.length) detail.append(el('p', 'No supporting evidence was returned.'));
      else {
        const list = el('ul', null, 'ai-evidence');
        evidence.slice(0, 12).forEach(item => {
          if (item && typeof item === 'object') list.append(el('li', `${String(item.description ?? item.id ?? 'Metric')}: ${String(item.value ?? 'n/a')}`));
        });
        detail.append(list);
      }
    } else if (key === 'investigation') {
      detail.append(el('p', next.reason || 'No next investigation suggested.'));
      if (next.expected_learning) detail.append(el('p', `Expected learning: ${next.expected_learning}`, 'ai-secondary'));
      const button = suggestedActionButton(next);
      if (button) actions.append(button);
    } else if (key === 'action') {
      detail.append(el('p', action.recommended && action.proposal ? action.proposal : 'A business action is not justified by the available evidence yet.'));
      if (action.rationale) detail.append(el('p', `Rationale: ${action.rationale}`, 'ai-secondary'));
      if (action.validation_needed) detail.append(el('p', `Validate first: ${action.validation_needed}`, 'ai-caution'));
    }
    const limitations = Array.isArray(interpretation.limitations) ? interpretation.limitations : [];
    if (limitations.length) {
      const details = el('details', null, 'ai-dialog-limitations');
      details.append(el('summary', 'Evidence limitations'));
      const list = el('ul');
      limitations.slice(0, 5).forEach(item => list.append(el('li', item)));
      details.append(list);
      detail.append(details);
    }
    workflow.cards.forEach(item => item.button?.classList.toggle('is-active', item.key === key));
    workflow.dialog.showModal();
  }

  workflow.networkTab?.addEventListener('click', () => setActiveMode('network'));
  workflow.nodeTab?.addEventListener('click', () => setActiveMode('node'));
  workflow.cards.forEach(stage => stage.button?.addEventListener('click', () => openStage(stage.key)));
  if (workflow.close) {
    workflow.close.disabled = false;
    workflow.close.addEventListener('click', () => workflow.dialog?.close());
  }
  workflow.dialog?.addEventListener('close', () => workflow.cards.forEach(stage => stage.button?.classList.remove('is-active')));
  if (workflow.networkTab) workflow.networkTab.disabled = false;
  if (workflow.nodeTab) workflow.nodeTab.disabled = false;

  let current = null;
  let prior = null;
  let selectedNode = null;
  let sequence = 0;
  let controller = null;
  let running = false;
  let disposed = false;

  function refreshNodeButton() {
    if (!nodeButton) return;
    // The button remains clickable after a graph is loaded, even without a
    // selection, so the app can explain the prerequisite instead of appearing
    // unresponsive. While a request runs it is deliberately locked.
    nodeButton.disabled = !current || running;
    nodeButton.textContent = selectedNode ? 'Analyse this node' : 'Select a node first';
    nodeButton.title = selectedNode
      ? `Interpret ${selectedNode.label} with local Ollama`
      : 'Click a graph node or an account in Rankings, then analyse it.';
  }

  function setStatus(message, state = '') {
    status.textContent = message;
    status.dataset.state = state;
  }

  function clearRequest() {
    closeProgress();
    sequence += 1;
    if (controller) controller.abort();
    controller = null;
    running = false;
    analyzeButton.disabled = false;
    refreshNodeButton();
  }

  function showPlaceholder(message) {
    content.replaceChildren(el('p', message, 'ai-empty'));
  }

  function render(data, snapshot, node = null) {
    const interpretation = data?.interpretation;
    if (!interpretation || typeof interpretation !== 'object') {
      throw new Error('The AI service did not return an interpretation.');
    }
    content.replaceChildren();
    const fragment = document.createDocumentFragment();
    if (node) {
      const focus = subsection('Selected node', `${node.label} (${node.id})`);
      const verified = data?.selected_node;
      if (verified) {
        focus.append(el('p',
          `Verified in/out degree: ${verified.in_degree}/${verified.out_degree}; ` +
          `direct neighbours: ${verified.direct_neighbours}; ` +
          `one-hop network: ${verified.local_nodes} nodes, ${verified.local_edges} edges.`,
          'ai-secondary'));
      }
      fragment.append(focus);
    }

    if (interpretation.warning) {
      fragment.append(subsection('Interpretation warning', interpretation.warning));
    }
    fragment.append(subsection('What are we seeing?', interpretation.what_we_see));
    fragment.append(subsection('Business meaning', interpretation.business_meaning));

    const evidence = Array.isArray(interpretation.evidence) ? interpretation.evidence : [];
    if (evidence.length) {
      const section = subsection('Supporting evidence');
      const list = el('ul', null, 'ai-evidence');
      for (const item of evidence.slice(0, 8)) {
        if (!item || typeof item !== 'object') continue;
        list.append(el('li', `${String(item.description ?? item.id ?? 'Metric')}: ${String(item.value ?? 'n/a')}`));
      }
      section.append(list);
      fragment.append(section);
    }

    const next = interpretation.next_investigation ?? {};
    const investigation = subsection('Next investigation', next.reason || 'No additional investigation suggested.');
    if (next.expected_learning) {
      investigation.append(el('p', `What to learn: ${next.expected_learning}`, 'ai-secondary'));
    }
    const investigationButton = suggestedActionButton(next);
    if (investigationButton) investigation.append(investigationButton);
    fragment.append(investigation);

    const action = interpretation.business_action ?? {};
    if (action.recommended && action.proposal) {
      const section = subsection('Possible business action', action.proposal);
      if (action.rationale) section.append(el('p', action.rationale, 'ai-secondary'));
      if (action.validation_needed) {
        section.append(el('p', `Validate first: ${action.validation_needed}`, 'ai-caution'));
      }
      fragment.append(section);
    } else {
      const section = subsection('Business action', 'Not justified by the available evidence yet.');
      if (action.validation_needed) {
        section.append(el('p', `Additional evidence: ${action.validation_needed}`, 'ai-secondary'));
      }
      fragment.append(section);
    }

    const limitations = Array.isArray(interpretation.limitations) ? interpretation.limitations : [];
    if (limitations.length) {
      const section = subsection('Limitations');
      const list = el('ul', null, 'ai-limitations');
      for (const text of limitations.slice(0, 5)) list.append(el('li', text));
      section.append(list);
      fragment.append(section);
    }

    const footer = el('p', null, 'ai-footer');
    const secs = Number(interpretation.elapsed_seconds);
    footer.textContent = [
      interpretation.model || modelSelect.value,
      Number.isFinite(secs) && secs > 0 ? `${secs.toFixed(1)} s` : null,
      snapshot?.visualization?.metric_scope ? `Metric scope: ${snapshot.visualization.metric_scope}` : null,
      'Generated interpretation — verify before acting',
    ].filter(Boolean).join(' · ');
    fragment.append(footer);
    content.append(fragment);
  }

  async function analyze() {
    if (!current || disposed) {
      setStatus('Load a dataset before requesting an interpretation.', 'error');
      return;
    }
    clearRequest();
    const ownSequence = sequence;
    const abort = new AbortController();
    controller = abort;
    running = true;
    analyzeButton.disabled = true;
    refreshNodeButton();
    setActiveMode('network');
    updateFreshness('Analysing network…', 'busy');
    setStatus('Interpreting the current graph with local Ollama…', 'busy');
    startProgress('network');

    const config = clone(current);
    const payload = {
      ...config,
      model: modelSelect.value,
      ...(prior && prior.dataset === current.dataset ? { previous: clone(prior) } : {}),
    };
    try {
      const response = await requestJSON(API_INTERPRET, payload, {
        signal: abort.signal,
        timeoutMs: 215_000,
      });
      if (disposed || ownSequence !== sequence) return;
      results.network = { response, node: null };
      closeProgress();
      setActiveMode('network');
      setStatus(response.interpretation?.warning || 'Interpretation ready', response.interpretation?.warning ? 'error' : 'success');
    } catch (error) {
      if (disposed || ownSequence !== sequence) return;
      showPlaceholder(`Network analysis failed: ${error.message}`);
      updateFreshness('Network analysis failed', 'error');
      setStatus(error.message, 'error');
      log(`AI analysis: ${error.message}`);
      showProgressError(error.message);
    } finally {
      if (ownSequence === sequence) {
        running = false;
        controller = null;
        analyzeButton.disabled = false;
        refreshNodeButton();
      }
    }
  }

  function onNodeSelected(node) {
    const id = node?.id == null ? null : String(node.id);
    if (id === selectedNode?.id) return;
    selectedNode = id ? { id, label: String(node.label ?? id) } : null;
    // A cached response to another account cannot be reused as evidence.
    results.node = null;
    if (workflow.dialog?.open) workflow.dialog.close();
    clearRequest();
    setActiveMode(selectedNode ? 'node' : 'network');
    refreshNodeButton();
    if (selectedNode) {
      setStatus(`Selected: ${selectedNode.label}. Click Analyse this node.`, '');
    }
  }

  async function interpretNode() {
    if (disposed) return;
    if (!current) {
      setStatus('Load a dataset first, then select a node.', 'error');
      return;
    }
    if (!selectedNode) {
      setActiveMode('node');
      const instruction = 'Select a node in the graph or the Rankings tab before pressing Analyse this node.';
      showPlaceholder(instruction);
      updateFreshness(instruction, 'error');
      setStatus(instruction, 'error');
      return;
    }
    clearRequest();
    const ownSequence = sequence;
    const abort = new AbortController();
    controller = abort;
    const node = { ...selectedNode };
    const config = clone(current);
    running = true;
    analyzeButton.disabled = true;
    refreshNodeButton();
    setActiveMode('node');
    updateFreshness(`Analysing ${short(node.label, node.id)}…`, 'busy');
    setStatus(`Interpreting selected node: ${node.label}…`, 'busy');
    showPlaceholder(`Examining verified relationships for ${node.label}…`);
    startProgress('node', node);
    try {
      const response = await requestJSON(API_INTERPRET_NODE, {
        ...config,
        node_id: node.id,
        model: modelSelect.value,
      }, { signal: abort.signal, timeoutMs: 215_000 });
      if (disposed || ownSequence !== sequence) return;
      results.node = { response, node };
      closeProgress();
      setActiveMode('node');
      setStatus(response.interpretation?.warning || `Node interpretation ready: ${node.label}`, response.interpretation?.warning ? 'error' : 'success');
    } catch (error) {
      if (disposed || ownSequence !== sequence) return;
      showPlaceholder(`Node analysis failed: ${error.message}`);
      updateFreshness('Node analysis failed', 'error');
      setStatus(error.message, 'error');
      log(`AI node analysis: ${error.message}`);
      showProgressError(error.message);
    } finally {
      if (ownSequence === sequence) {
        running = false;
        controller = null;
        analyzeButton.disabled = false;
        refreshNodeButton();
      }
    }
  }

  /** Call *after* Flask confirms the graph/layout update. */
  function onViewApplied(settings) {
    if (disposed || !settings) return;
    const next = clone(settings);
    if (current && JSON.stringify(next) === JSON.stringify(current)) return;
    prior = current && current.dataset === next.dataset ? current : null;
    current = next;
    selectedNode = null;
    results.network = null;
    results.node = null;
    if (workflow.dialog?.open) workflow.dialog.close();
    clearRequest();
    setActiveMode('network');
    showPlaceholder('Current view changed. Analyse to interpret the updated graph.');
    setStatus('View updated', '');
    if (modeSelect.value === 'auto') void analyze();
  }

  function onButtonClick() { void analyze(); }
  function onNodeButtonClick() { void interpretNode(); }
  analyzeButton.addEventListener('click', onButtonClick);
  nodeButton?.addEventListener('click', onNodeButtonClick);

  async function loadModels() {
    try {
      const response = await requestJSON(API_MODELS, undefined, { timeoutMs: 12_000 });
      const models = Array.isArray(response.models) ? response.models : [];
      if (!models.length) throw new Error('No AI models configured.');
      modelSelect.replaceChildren();
      for (const model of models) {
        const option = el('option', model);
        option.value = String(model);
        modelSelect.append(option);
      }
      const defaultModel = response.default;
      modelSelect.value = models.includes(defaultModel) ? defaultModel : models[0];
      setStatus('Ready — local models available');
    } catch (error) {
      // Preserve the static qwen3:8b option in the HTML as an offline fallback.
      setStatus(`AI endpoint not ready: ${error.message}`, 'error');
    }
  }

  showPlaceholder('Select a dataset to begin.');
  setActiveMode('network');
  void loadModels();

  return {
    onViewApplied,
    onNodeSelected,
    analyze,
    interpretNode,
    destroy() {
      disposed = true;
      resolveApproval(false);
      clearRequest();
      analyzeButton.removeEventListener('click', onButtonClick);
      nodeButton?.removeEventListener('click', onNodeButtonClick);
    },
  };
}
