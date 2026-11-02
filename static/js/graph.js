/**
 * Network Analytics Studio — interactive Canvas 2D graph renderer.
 *
 * Independent of third-party JavaScript libraries. Graph layouts and centrality
 * values come from Flask; this module handles presentation and interaction.
 * Public API consumed by controls.js / layouts.js:
 *   setGraph, setSizes, setColors, setPositions, positions, sizes, fit,
 *   panZoom, select, savePNG, draw, showLabels.
 */

const PALETTE = [
  '#4F46E5', '#0D9488', '#E59A28', '#DC4D83', '#7C3AED', '#0284C7',
  '#65A30D', '#EA580C', '#6366F1', '#16A6A1', '#B45309', '#9333EA',
  '#BE185D', '#0891B2', '#4D7C0F', '#C2410C', '#1D4ED8', '#0F766E',
];
const number = (value, fallback = 0) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

export class GraphCanvas {
  constructor(canvas, onSelect = () => {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new TypeError('GraphCanvas requires an HTML canvas element.');
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('Canvas 2D is unavailable in this browser.');

    this.onSelect = onSelect;
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.zoom = 1;
    this.offset = { x: 0, y: 0 };
    this.width = 1;
    this.height = 1;
    this.sizeMin = 3;
    this.sizeMax = 42;
    this.colorMode = 'community';
    this.showLabels = true;
    this.selected = null;
    this.highlighted = new Set();
    this.drag = null;
    this.lastDown = null;
    this.pendingDraw = false;

    // Observe the parent: its dimensions determine the CSS-sized canvas.
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
    this.attachEvents();
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  setGraph(nodes, edges, { fit = true } = {}) {
    // Preserve the current visual layout during metric-only refreshes.
    const previous = this.byId;
    const preserve = !fit && this.nodes.length > 0 &&
      this.nodes.length === nodes.length &&
      nodes.every(node => previous.has(String(node.id)));

    this.nodes = nodes.map(item => {
      const id = String(item.id);
      const old = preserve ? previous.get(id) : null;
      return {
        ...item,
        id,
        label: String(item.label || id),
        metric: Math.max(0, number(item.metric)),
        x: old ? old.x : number(item.x),
        y: old ? old.y : number(item.y),
      };
    });
    this.byId = new Map(this.nodes.map(node => [node.id, node]));
    this.edges = edges.map(edge => ({
      ...edge,
      source: String(edge.source),
      target: String(edge.target),
      weight: Math.max(0, number(edge.weight, 1)),
    }));

    if (!this.byId.has(this.selected)) this.selected = null;
    this.scaleSizes();
    if (fit || !preserve) this.fit();
    else this.draw();
  }

  scaleSizes() {
    let maxMetric = 0;
    for (const node of this.nodes) maxMetric = Math.max(maxMetric, node.metric);
    // Screen-space radii keep size sliders useful at all zoom levels.
    for (const node of this.nodes) {
      const magnitude = maxMetric > 0 ? Math.sqrt(node.metric / maxMetric) : 0;
      node.radius = this.sizeMin + magnitude * (this.sizeMax - this.sizeMin);
    }
  }

  setSizes(minimum, maximum) {
    this.sizeMin = clamp(number(minimum, 3), 1, 100);
    this.sizeMax = clamp(number(maximum, 42), this.sizeMin, 150);
    this.scaleSizes();
    this.draw();
  }

  setHighlights(ids = []) {
    // AI focus is a visual annotation, not a change to graph topology.
    this.highlighted = new Set(
      ids.map(String).filter(id => this.byId.has(id))
    );
    this.draw();
  }

  setColors(mode) {
    if (!['community', 'category', 'uniform'].includes(mode)) {
      throw new Error(`Unsupported colour mode: ${mode}`);
    }
    this.colorMode = mode;
    this.draw();
  }

  color(node) {
    if (this.colorMode === 'uniform') return '#4F46E5';
    const key = this.colorMode === 'category' ? node.category : node.community;
    // A direct index makes communities 0,1,2... easy to distinguish.
    if (this.colorMode === 'community' && Number.isInteger(Number(key)) && Number(key) >= 0) {
      return PALETTE[Number(key) % PALETTE.length];
    }
    return PALETTE[stableHash(key) % PALETTE.length];
  }

  positions() {
    return Object.fromEntries(this.nodes.map(node => [node.id, [node.x, node.y]]));
  }

  sizes() {
    return Object.fromEntries(this.nodes.map(node => [node.id, node.radius]));
  }

  setPositions(positions, { fit = true } = {}) {
    for (const node of this.nodes) {
      const p = positions?.[node.id];
      if (Array.isArray(p) && p.length === 2 &&
          Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) {
        node.x = Number(p[0]);
        node.y = Number(p[1]);
      }
    }
    if (fit) this.fit();
    else this.draw();
  }

  fit() {
    if (!this.nodes.length) {
      this.zoom = 1;
      this.offset = { x: this.width / 2, y: this.height / 2 };
      this.draw();
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of this.nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }
    const padding = Math.max(48, this.sizeMax + 12);
    const availableW = Math.max(30, this.width - 2 * padding);
    const availableH = Math.max(30, this.height - 2 * padding);
    this.zoom = clamp(Math.min(
      availableW / Math.max(1, maxX - minX),
      availableH / Math.max(1, maxY - minY),
    ), 0.015, 8);
    this.offset = {
      x: this.width / 2 - ((minX + maxX) / 2) * this.zoom,
      y: this.height / 2 - ((minY + maxY) / 2) * this.zoom,
    };
    this.draw();
  }

  panZoom(factor, anchorX = this.width / 2, anchorY = this.height / 2) {
    const target = clamp(this.zoom * factor, 0.01, 30);
    const scale = target / this.zoom;
    this.offset.x = anchorX + (this.offset.x - anchorX) * scale;
    this.offset.y = anchorY + (this.offset.y - anchorY) * scale;
    this.zoom = target;
    this.draw();
  }

  screenCoords(node) {
    return [node.x * this.zoom + this.offset.x,
            node.y * this.zoom + this.offset.y];
  }

  pick(x, y) {
    let closest = null;
    let best = Infinity;
    // Iterating from the end gives the higher-ranked (last-drawn) nodes
    // priority in case two circles overlap.
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const [sx, sy] = this.screenCoords(node);
      const distance = Math.hypot(sx - x, sy - y);
      const ratio = distance / Math.max(6, node.radius + 4);
      if (ratio <= 1 && ratio < best) {
        closest = node;
        best = ratio;
      }
    }
    return closest;
  }

  draw() {
    if (!this.ctx) return;
    const c = this.ctx;
    c.clearRect(0, 0, this.width, this.height);
    if (!this.nodes.length) return;

    // Draw edges in one path for thousands of edges without DOM overhead.
    c.save();
    c.beginPath();
    c.strokeStyle = 'rgba(100,116,139,0.22)';
    c.lineWidth = 0.75;
    for (const edge of this.edges) {
      const a = this.byId.get(edge.source), b = this.byId.get(edge.target);
      if (!a || !b) continue;
      const [x1, y1] = this.screenCoords(a);
      const [x2, y2] = this.screenCoords(b);
      if ((x1 < -60 && x2 < -60) || (x1 > this.width + 60 && x2 > this.width + 60) ||
          (y1 < -60 && y2 < -60) || (y1 > this.height + 60 && y2 > this.height + 60)) continue;
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
    }
    c.stroke();

    // Small nodes first; large nodes last, so the most significant are visible.
    const ordered = [...this.nodes].sort((a, b) => a.radius - b.radius);
    for (const node of ordered) {
      const [x, y] = this.screenCoords(node);
      const r = Math.max(1.2, node.radius);
      if (x + r < 0 || x - r > this.width || y + r < 0 || y - r > this.height) continue;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = this.color(node);
      c.globalAlpha = node.id === this.selected ? 1 : 0.85;
      c.fill();
    }
    c.globalAlpha = 1;

    // Gold rings mark explicitly verified AI focus seeds; their immediate
    // counterparties retain their original community colours.
    for (const id of this.highlighted) {
      const node = this.byId.get(id);
      if (!node) continue;
      const [x, y] = this.screenCoords(node);
      c.beginPath();
      c.arc(x, y, Math.max(2, node.radius) + 4, 0, Math.PI * 2);
      c.lineWidth = 2.5;
      c.strokeStyle = '#D97706';
      c.stroke();
    }

    const selected = this.byId.get(this.selected);
    if (selected) {
      const [x, y] = this.screenCoords(selected);
      c.beginPath();
      c.arc(x, y, Math.max(2, selected.radius) + 3, 0, Math.PI * 2);
      c.lineWidth = 2.5;
      c.strokeStyle = '#0F172A';
      c.stroke();
    }

    if (this.showLabels || selected) {
      const ranked = this.showLabels
        ? [...this.nodes].filter(n => n.metric > 0)
          .sort((a, b) => b.metric - a.metric).slice(0, 12)
        : [];
      for (const id of this.highlighted) {
        const node = this.byId.get(id);
        if (node && !ranked.includes(node)) ranked.push(node);
      }
      if (selected && !ranked.includes(selected)) ranked.push(selected);
      c.font = '600 11px Inter, system-ui, sans-serif';
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      for (const node of ranked) {
        const [x, y] = this.screenCoords(node);
        if (x < -50 || y < -10 || x > this.width + 10 || y > this.height + 10) continue;
        const text = node.label.slice(0, 34);
        const textX = x + node.radius + 5;
        c.lineWidth = 3;
        c.strokeStyle = 'rgba(255,255,255,.92)';
        c.strokeText(text, textX, y);
        c.fillStyle = '#334155';
        c.fillText(text, textX, y);
      }
    }
    c.restore();
  }

  attachEvents() {
    const canvas = this.canvas;
    const local = event => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const point = local(event);
      this.panZoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, point.x, point.y);
    }, { passive: false });

    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const point = local(event);
      const picked = this.pick(point.x, point.y);
      this.lastDown = { x: event.clientX, y: event.clientY };
      this.drag = {
        x: event.clientX,
        y: event.clientY,
        node: event.shiftKey ? picked : null,
      };
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', event => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      if (this.drag.node) {
        this.drag.node.x += dx / this.zoom;
        this.drag.node.y += dy / this.zoom;
      } else {
        this.offset.x += dx;
        this.offset.y += dy;
      }
      this.draw();
    });

    canvas.addEventListener('pointerup', event => {
      if (this.lastDown &&
          Math.hypot(event.clientX - this.lastDown.x, event.clientY - this.lastDown.y) < 5) {
        const point = local(event);
        const node = this.pick(point.x, point.y);
        this.selected = node?.id ?? null;
        this.onSelect(node);
        this.draw();
      }
      this.drag = null;
      this.lastDown = null;
    });

    canvas.addEventListener('pointercancel', () => {
      this.drag = null;
      this.lastDown = null;
    });

    canvas.addEventListener('keydown', event => {
      if (event.key === '+' || event.key === '=') this.panZoom(1.2);
      else if (event.key === '-') this.panZoom(1 / 1.2);
      else if (event.key.toLowerCase() === 'f') this.fit();
    });
  }

  select(id) {
    this.selected = id == null ? null : String(id);
    const node = this.byId.get(this.selected);
    if (node) {
      this.offset.x = this.width / 2 - node.x * this.zoom;
      this.offset.y = this.height / 2 - node.y * this.zoom;
    }
    this.onSelect(node ?? null);
    this.draw();
  }

  savePNG() {
    const link = document.createElement('a');
    link.download = 'network-analytics.png';
    link.href = this.canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}
