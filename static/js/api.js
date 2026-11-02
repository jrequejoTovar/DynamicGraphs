/**
 * Network Analytics Studio — Flask API client.
 *
 * All URLs are relative to the current origin. The existing frontend can keep
 * importing requestJSON(url, payload); optional named helpers are provided.
 */

const API_ROOT = '/api';
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Fetch JSON from Flask.
 *
 * - requestJSON('/api/datasets')             -> GET
 * - requestJSON('/api/graph', { ... })       -> POST JSON
 * - requestJSON('/api/layout', { ... })      -> POST JSON
 *
 * A payload of null is still sent as a POST; omitting it produces a GET.
 */
export async function requestJSON(url, payload, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/')) {
    throw new Error('API URL must be a relative path starting with /.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortOnExternalSignal = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortOnExternalSignal, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const options = {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  };

  if (payload !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }

  try {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Unexpected server response (HTTP ${response.status}). Check that Flask is running.`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Invalid JSON returned by the server (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message = data && typeof data.error === 'string'
        ? data.error
        : `Request failed (HTTP ${response.status}).`;
      throw new Error(message);
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(timedOut
        ? 'The analysis timed out. Try fewer nodes or fewer layout iterations.'
        : 'Request cancelled.');
    }
    if (error instanceof TypeError) {
      throw new Error('Cannot reach Flask. Verify that the application is running.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortOnExternalSignal);
  }
}

export const listDatasets = () => requestJSON(`${API_ROOT}/datasets`);
export const fetchGraph = (options) => requestJSON(`${API_ROOT}/graph`, options);
export const fetchLayout = (options) => requestJSON(`${API_ROOT}/layout`, options);
export const fetchNode = (dataset, id) =>
  requestJSON(`${API_ROOT}/node`, { dataset, id });
