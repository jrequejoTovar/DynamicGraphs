/** Request layout coordinates from Flask; Canvas handles rendering and camera. */
import { fetchLayout } from './api.js';

export function layoutOptions(controls) {
  return {
    scaling: Number(controls.scaling.value),
    gravity: Number(controls.gravity.value),
    iterations: Number(controls.iterations.value),
    prevent_overlap: controls.preventOverlap.checked,
    use_weights: controls.useWeights.checked,
    linlog: controls.linlog.checked,
    strong_gravity: controls.strongGravity.checked,
  };
}

export async function applyLayout(state, canvas, controls) {
  if (!state?.dataset) throw new Error('Choose a dataset first.');
  const layout = controls.layout.value;
  const result = await fetchLayout({
    dataset: state.dataset,
    filters: state.filters ?? {},
    layout,
    options: layoutOptions(controls),
    positions: canvas.positions(),
    sizes: canvas.sizes(),
  });
  if (!result?.positions || typeof result.positions !== 'object') {
    throw new Error('Flask did not return valid layout coordinates.');
  }
  canvas.setPositions(result.positions, { fit: true });
  return result;
}
