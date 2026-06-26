const canvas = document.querySelector('#planCanvas');
const ctx = canvas.getContext('2d');
const shell = canvas.parentElement;
const $ = (selector) => document.querySelector(selector);
const gridPixels = (inches) => ({ 3: 20, 6: 25, 12: 32, 24: 44 })[inches] || 32;
const DEFAULT_WALL_COLOR = '#30332d';
const DEFAULT_SHAPE_COLOR = '#59615b';
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function readLocalProject() {
  try {
    const project = JSON.parse(localStorage.getItem('gridline-project'));
    if (project && Array.isArray(project.walls)) return project;
  } catch (_) { /* Ignore corrupt local data. */ }
  try {
    const walls = JSON.parse(localStorage.getItem('gridline-walls') || '[]');
    return { walls: Array.isArray(walls) ? walls : [] };
  } catch (_) { return { walls: [] }; }
}

const saved = readLocalProject();
const state = {
  walls: saved.walls || [], labels: saved.labels || [], rulers: saved.rulers || [], shapes: saved.shapes || [], history: [], future: [], tool: 'wall',
  drawing: false, panning: false, start: null, preview: null, panPointer: null, spacePressed: false,
  selectedWall: null, editingHandle: null, editSnapshot: null,
  selectedLabel: null, draggingLabel: false, labelSnapshot: null, labelDragOffset: null, labelSizeSnapshot: null,
  drawingRuler: false, rulerStart: null, rulerPreview: null,
  selectedRuler: null, rulerDragMode: null, rulerDragSnapshot: null, rulerDragStart: null, rulerDragOriginal: null,
  drawingShape: false, shapeStart: null, shapePreview: null, shapeKind: 'square', selectedShape: null,
  wallSizeSnapshot: null, lineStyleSnapshot: null,
  serverId: saved.server?.id || null, serverName: saved.server?.name || 'Untitled plan',
  dirty: saved.localState?.dirty === true,
  zoom: Number(saved.viewport?.zoom) || 1,
  offset: { x: Number(saved.viewport?.offset?.x) || 0, y: Number(saved.viewport?.offset?.y) || 0 },
  gridInches: Number(saved.settings?.gridInches) || 12,
  wallWidth: Number(saved.settings?.wallWidth) || 6,
  showText: saved.settings?.showText !== false, showDimensions: saved.settings?.showDimensions !== false,
  grid: 32, dpr: window.devicePixelRatio || 1,
};
state.grid = gridPixels(state.gridInches);

const documentSnapshot = () => structuredClone({ walls: state.walls, labels: state.labels, rulers: state.rulers, shapes: state.shapes });
function restoreSnapshot(snapshot) {
  state.walls = structuredClone(snapshot.walls || []);
  state.labels = structuredClone(snapshot.labels || []);
  state.rulers = structuredClone(snapshot.rulers || []);
  state.shapes = structuredClone(snapshot.shapes || []);
}
function pushHistory(snapshot = documentSnapshot()) {
  state.history.push(snapshot); if (state.history.length > 100) state.history.shift();
  state.future = [];
}
function markDirty() { state.dirty = true; }

const snap = (value) => Math.round(value / state.grid) * state.grid;
const samePoint = (a, b) => a.x === b.x && a.y === b.y;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalizeColor = (value, fallback) => typeof value === 'string' && COLOR_PATTERN.test(value) ? value.toLowerCase() : fallback;
const normalizeShade = (value) => Number.isFinite(Number(value)) ? clamp(Number(value), .2, 1) : 1;
const pixelsToInches = (pixels) => pixels / state.grid * state.gridInches;
const feetToPixels = (feet) => feet * 12 / state.gridInches * state.grid;
const trimNumber = (value, places = 2) => Number(value.toFixed(places)).toString();
const screenPoint = (event) => {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};
const canvasPoint = (event) => {
  const point = screenPoint(event);
  return { x: snap((point.x - state.offset.x) / state.zoom), y: snap((point.y - state.offset.y) / state.zoom) };
};
const rawCanvasPoint = (event) => {
  const point = screenPoint(event);
  return { x: (point.x - state.offset.x) / state.zoom, y: (point.y - state.offset.y) / state.zoom };
};
const clampZoom = (value) => Math.max(.1, Math.min(2, value));

function wallLengthInches(wall) {
  return Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) / state.grid * state.gridInches;
}

function formatLength(inches) {
  const rawTotal = Math.max(0, Number(inches) || 0);
  if (Math.abs(rawTotal - Math.round(rawTotal)) > .01) return `${trimNumber(rawTotal / 12)} ft`;
  const total = Math.round(rawTotal);
  const feet = Math.floor(total / 12), remainder = total % 12;
  if (!feet) return `${remainder} in`;
  return remainder ? `${feet} ft ${remainder} in` : `${feet} ft`;
}

function feetValueFromInches(inches) { return trimNumber((Number(inches) || 0) / 12); }

function resize() {
  const { width, height } = shell.getBoundingClientRect();
  canvas.width = Math.floor(width * state.dpr); canvas.height = Math.floor(height * state.dpr);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; draw();
}

function drawGrid(width, height) {
  const spacing = state.grid * state.zoom;
  const startX = ((state.offset.x % spacing) + spacing) % spacing;
  const startY = ((state.offset.y % spacing) + spacing) % spacing;
  ctx.lineWidth = 1;
  for (let x = startX; x <= width; x += spacing) {
    const index = Math.round((x - state.offset.x) / spacing);
    ctx.strokeStyle = index % 5 === 0 ? '#c7c3b8' : '#d6d2c7';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = startY; y <= height; y += spacing) {
    const index = Math.round((y - state.offset.y) / spacing);
    ctx.strokeStyle = index % 5 === 0 ? '#c7c3b8' : '#d6d2c7';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
}

function drawWall(wall, preview = false, selected = false) {
  ctx.save(); ctx.translate(state.offset.x, state.offset.y); ctx.scale(state.zoom, state.zoom);
  ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
  ctx.strokeStyle = preview ? '#b54b2d' : normalizeColor(wall.color, DEFAULT_WALL_COLOR); ctx.globalAlpha = preview ? .65 : normalizeShade(wall.shade);
  ctx.lineWidth = Math.max(2, (wall.thickness || state.wallWidth) / state.gridInches * state.grid);
  ctx.beginPath(); ctx.moveTo(wall.a.x, wall.a.y); ctx.lineTo(wall.b.x, wall.b.y); ctx.stroke(); ctx.restore();
  if (preview) drawWallPreviewLength(wall);
}

function drawWallPreviewLength(wall) {
  const ax = state.offset.x + wall.a.x * state.zoom, ay = state.offset.y + wall.a.y * state.zoom;
  const bx = state.offset.x + wall.b.x * state.zoom, by = state.offset.y + wall.b.y * state.zoom;
  const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length, ny = dx / length;
  const wallPixels = Math.max(2, (wall.thickness || state.wallWidth) / state.gridInches * state.grid * state.zoom);
  const x = (ax + bx) / 2 + nx * (wallPixels / 2 + 13), y = (ay + by) / 2 + ny * (wallPixels / 2 + 13);
  const label = formatLength(wallLengthInches(wall));
  ctx.save(); ctx.font = '600 11px "DM Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const width = ctx.measureText(label).width + 12; ctx.fillStyle = 'rgba(247,244,236,.92)'; ctx.fillRect(x - width / 2, y - 10, width, 20);
  ctx.fillStyle = '#a34329'; ctx.fillText(label, x, y + .5); ctx.restore();
}

function drawEditHandles(wall) {
  ctx.save();
  [wall.a, wall.b].forEach((point) => {
    const x = state.offset.x + point.x * state.zoom, y = state.offset.y + point.y * state.zoom;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#fffdf8'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#b54b2d'; ctx.stroke();
  });
  ctx.restore();
}

function labelMetrics(label) {
  ctx.save(); ctx.font = `600 ${label.fontSize || 16}px "DM Sans", sans-serif`;
  const width = ctx.measureText(label.text).width; ctx.restore();
  return { width, height: (label.fontSize || 16) * 1.35 };
}

function labelAtPoint(point) {
  for (let i = state.labels.length - 1; i >= 0; i -= 1) {
    const label = state.labels[i], metrics = labelMetrics(label);
    if (Math.abs(point.x - label.x) <= metrics.width / 2 + 8 && Math.abs(point.y - label.y) <= metrics.height / 2 + 6) return i;
  }
  return -1;
}

function drawLabel(label, selected = false) {
  const fontSize = label.fontSize || 16;
  ctx.save(); ctx.translate(state.offset.x, state.offset.y); ctx.scale(state.zoom, state.zoom);
  ctx.font = `600 ${fontSize}px "DM Sans", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const metrics = labelMetrics(label);
  if (selected) {
    ctx.fillStyle = 'rgba(247,244,236,.9)'; ctx.strokeStyle = '#b54b2d'; ctx.lineWidth = 1.5 / state.zoom;
    ctx.setLineDash([5 / state.zoom, 3 / state.zoom]);
    ctx.fillRect(label.x - metrics.width / 2 - 7, label.y - metrics.height / 2 - 4, metrics.width + 14, metrics.height + 8);
    ctx.strokeRect(label.x - metrics.width / 2 - 7, label.y - metrics.height / 2 - 4, metrics.width + 14, metrics.height + 8);
  }
  ctx.fillStyle = '#292b26'; ctx.fillText(label.text, label.x, label.y); ctx.restore();
}

function rulerLabelWorldPosition(ruler) {
  const midpoint = { x: (ruler.a.x + ruler.b.x) / 2, y: (ruler.a.y + ruler.b.y) / 2 };
  if (ruler.labelOffset) return { x: midpoint.x + ruler.labelOffset.x, y: midpoint.y + ruler.labelOffset.y };
  const dx = ruler.b.x - ruler.a.x, dy = ruler.b.y - ruler.a.y, length = Math.hypot(dx, dy) || 1;
  return { x: midpoint.x - dy / length * (15 / state.zoom), y: midpoint.y + dx / length * (15 / state.zoom) };
}

function drawRuler(ruler, preview = false, selected = false) {
  const ax = state.offset.x + ruler.a.x * state.zoom, ay = state.offset.y + ruler.a.y * state.zoom;
  const bx = state.offset.x + ruler.b.x * state.zoom, by = state.offset.y + ruler.b.y * state.zoom;
  const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length, ny = dx / length;
  ctx.save();
  ctx.strokeStyle = preview || selected ? '#b54b2d' : '#436b73'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
  [[ax, ay], [bx, by]].forEach(([x, y]) => { ctx.beginPath(); ctx.moveTo(x - nx * 6, y - ny * 6); ctx.lineTo(x + nx * 6, y + ny * 6); ctx.stroke(); });
  const labelPosition = rulerLabelWorldPosition(ruler);
  const label = formatLength(wallLengthInches(ruler)), x = state.offset.x + labelPosition.x * state.zoom, y = state.offset.y + labelPosition.y * state.zoom;
  ctx.font = '600 11px \"DM Sans\", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = preview || selected ? '#a34329' : '#355c64'; ctx.fillText(label, x, y + .5); ctx.restore();
  if (selected) {
    ctx.save(); ctx.fillStyle = '#fffdf8'; ctx.strokeStyle = '#b54b2d'; ctx.lineWidth = 2;
    [[ax, ay], [bx, by]].forEach(([px, py]) => { ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
    ctx.restore();
  }
}

function rulerPartAtEvent(event, ruler) {
  const screen = screenPoint(event);
  const a = { x: state.offset.x + ruler.a.x * state.zoom, y: state.offset.y + ruler.a.y * state.zoom };
  const b = { x: state.offset.x + ruler.b.x * state.zoom, y: state.offset.y + ruler.b.y * state.zoom };
  if (Math.hypot(screen.x - a.x, screen.y - a.y) <= 12) return 'a';
  if (Math.hypot(screen.x - b.x, screen.y - b.y) <= 12) return 'b';
  const position = rulerLabelWorldPosition(ruler);
  const labelX = state.offset.x + position.x * state.zoom, labelY = state.offset.y + position.y * state.zoom;
  ctx.save(); ctx.font = '600 11px "DM Sans", sans-serif';
  const labelWidth = ctx.measureText(formatLength(wallLengthInches(ruler))).width + 12; ctx.restore();
  if (Math.abs(screen.x - labelX) <= labelWidth / 2 && Math.abs(screen.y - labelY) <= 12) return 'label';
  return pointToSegmentDistance(rawCanvasPoint(event), ruler.a, ruler.b) <= 12 / state.zoom ? 'body' : null;
}

function shapeFromDrag(type, start, end) {
  if (type === 'line' || type === 'rectangle') return { type, a: { ...start }, b: { ...end }, color: DEFAULT_SHAPE_COLOR, shade: 1 };
  if (type === 'square') {
    const size = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    return { type, a: { ...start }, b: { x: start.x + Math.sign(end.x - start.x || 1) * size, y: start.y + Math.sign(end.y - start.y || 1) * size }, color: DEFAULT_SHAPE_COLOR, shade: 1 };
  }
  return { type, center: { ...start }, radius: Math.hypot(end.x - start.x, end.y - start.y), color: DEFAULT_SHAPE_COLOR, shade: 1 };
}

function drawShape(shape, preview = false, selected = false) {
  ctx.save(); ctx.translate(state.offset.x, state.offset.y); ctx.scale(state.zoom, state.zoom);
  ctx.strokeStyle = preview ? '#b54b2d' : normalizeColor(shape.color, DEFAULT_SHAPE_COLOR); ctx.globalAlpha = preview ? .7 : normalizeShade(shape.shade);
  ctx.lineWidth = 2 / state.zoom; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  if (shape.type === 'line') { ctx.moveTo(shape.a.x, shape.a.y); ctx.lineTo(shape.b.x, shape.b.y); }
  else if (shape.type === 'square' || shape.type === 'rectangle') {
    const x = Math.min(shape.a.x, shape.b.x), y = Math.min(shape.a.y, shape.b.y);
    ctx.rect(x, y, Math.abs(shape.b.x - shape.a.x), Math.abs(shape.b.y - shape.a.y));
  } else if (shape.type === 'circle') ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, Math.PI * 2);
  else {
    ctx.arc(shape.center.x, shape.center.y, shape.radius, Math.PI, Math.PI * 2);
    ctx.lineTo(shape.center.x - shape.radius, shape.center.y);
  }
  ctx.stroke();
  if (selected && !preview) {
    ctx.globalAlpha = 1; ctx.strokeStyle = '#b54b2d'; ctx.lineWidth = 1.5 / state.zoom; ctx.setLineDash([6 / state.zoom, 4 / state.zoom]); ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  const width = canvas.width / state.dpr, height = canvas.height / state.dpr;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#e7e3d8'; ctx.fillRect(0, 0, width, height); drawGrid(width, height);
  state.shapes.forEach((shape, index) => drawShape(shape, false, state.tool === 'shapes' && index === state.selectedShape));
  state.walls.forEach((wall, index) => drawWall(wall, false, state.tool === 'edit' && index === state.selectedWall));
  if (state.showText) state.labels.forEach((label, index) => drawLabel(label, state.tool === 'text' && index === state.selectedLabel));
  if (state.showDimensions) state.rulers.forEach((ruler, index) => drawRuler(ruler, false, state.tool === 'ruler' && index === state.selectedRuler));
  if (state.preview) drawWall(state.preview, true);
  if (state.rulerPreview) drawRuler(state.rulerPreview, true);
  if (state.shapePreview) drawShape(state.shapePreview, true);
  if (state.tool === 'edit' && state.selectedWall !== null && state.walls[state.selectedWall]) drawEditHandles(state.walls[state.selectedWall]);
}

function projectData() {
  return {
    format: 'gridline-floor-plan', version: 5, exportedAt: new Date().toISOString(),
    settings: { gridInches: state.gridInches, wallWidth: state.wallWidth, showText: state.showText, showDimensions: state.showDimensions },
    viewport: { zoom: state.zoom, offset: { ...state.offset } },
    walls: state.walls.map((wall) => ({ a: { ...wall.a }, b: { ...wall.b }, thickness: wall.thickness || state.wallWidth, color: normalizeColor(wall.color, DEFAULT_WALL_COLOR), shade: normalizeShade(wall.shade) })),
    labels: state.labels.map((label) => ({ text: label.text, x: label.x, y: label.y, fontSize: label.fontSize || 16 })),
    rulers: state.rulers.map((ruler) => ({ a: { ...ruler.a }, b: { ...ruler.b }, ...(ruler.labelOffset ? { labelOffset: { ...ruler.labelOffset } } : {}) })),
    shapes: state.shapes.map((shape) => structuredClone(shape)),
    server: state.serverId ? { id: state.serverId, name: state.serverName } : null,
  };
}

function persist() {
  const localData = projectData();
  localData.localState = { dirty: state.dirty };
  localStorage.setItem('gridline-project', JSON.stringify(localData));
  localStorage.removeItem('gridline-walls');
  $('#saveStatus').textContent = state.dirty ? 'Unsaved changes' : state.serverId ? 'Saved' : 'Ready';
}

function commit(nextWalls) {
  pushHistory(); state.walls = nextWalls; markDirty(); persist(); draw(); updateUi();
}

function commitLabels(nextLabels) {
  pushHistory(); state.labels = nextLabels; markDirty(); persist(); draw(); updateUi();
}

function commitRulers(nextRulers) {
  pushHistory(); state.rulers = nextRulers; markDirty(); persist(); draw(); updateUi();
}

function commitShapes(nextShapes) {
  pushHistory(); state.shapes = nextShapes; markDirty(); persist(); draw(); updateUi();
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function shapeAtPoint(point) {
  const tolerance = 10 / state.zoom;
  for (let i = state.shapes.length - 1; i >= 0; i -= 1) {
    const shape = state.shapes[i];
    if (shape.type === 'line' && pointToSegmentDistance(point, shape.a, shape.b) <= tolerance) return i;
    if (shape.type === 'square' || shape.type === 'rectangle') {
      const x1 = Math.min(shape.a.x, shape.b.x), x2 = Math.max(shape.a.x, shape.b.x);
      const y1 = Math.min(shape.a.y, shape.b.y), y2 = Math.max(shape.a.y, shape.b.y);
      const edges = [[{ x: x1, y: y1 }, { x: x2, y: y1 }], [{ x: x2, y: y1 }, { x: x2, y: y2 }], [{ x: x2, y: y2 }, { x: x1, y: y2 }], [{ x: x1, y: y2 }, { x: x1, y: y1 }]];
      if (edges.some(([a, b]) => pointToSegmentDistance(point, a, b) <= tolerance)) return i;
    }
    if (shape.type === 'circle' && Math.abs(Math.hypot(point.x - shape.center.x, point.y - shape.center.y) - shape.radius) <= tolerance) return i;
    if (shape.type === 'semicircle') {
      const arcHit = point.y <= shape.center.y + tolerance && Math.abs(Math.hypot(point.x - shape.center.x, point.y - shape.center.y) - shape.radius) <= tolerance;
      const baseHit = pointToSegmentDistance(point, { x: shape.center.x - shape.radius, y: shape.center.y }, { x: shape.center.x + shape.radius, y: shape.center.y }) <= tolerance;
      if (arcHit || baseHit) return i;
    }
  }
  return -1;
}

function shapeTypeLabel(shape) { return shape.type === 'semicircle' ? 'semi-circle' : shape.type; }

function shapeSizeText(shape) {
  if (shape.type === 'line') return formatLength(wallLengthInches(shape));
  if (shape.type === 'square' || shape.type === 'rectangle') {
    const width = formatLength(pixelsToInches(Math.abs(shape.b.x - shape.a.x)));
    const height = formatLength(pixelsToInches(Math.abs(shape.b.y - shape.a.y)));
    return `${width} × ${height}`;
  }
  if (shape.type === 'circle') return `dia ${formatLength(pixelsToInches(shape.radius * 2))}`;
  return `dia ${formatLength(pixelsToInches(shape.radius * 2))}`;
}

function selectedLineElement() {
  if (state.selectedWall !== null && state.walls[state.selectedWall]) return { kind: 'wall', index: state.selectedWall, item: state.walls[state.selectedWall], fallback: DEFAULT_WALL_COLOR };
  if (state.selectedShape !== null && state.shapes[state.selectedShape]) return { kind: 'shape', index: state.selectedShape, item: state.shapes[state.selectedShape], fallback: DEFAULT_SHAPE_COLOR };
  return null;
}

function setSegmentLength(segment, feet) {
  const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y, current = Math.hypot(dx, dy) || 1;
  const length = feetToPixels(feet);
  segment.b = { x: segment.a.x + dx / current * length, y: segment.a.y + dy / current * length };
}

function setAxisLength(shape, axis, feet) {
  const length = feetToPixels(feet), delta = axis === 'x' ? shape.b.x - shape.a.x : shape.b.y - shape.a.y;
  const sign = delta < 0 ? -1 : 1;
  shape.b = { ...shape.b, [axis]: shape.a[axis] + sign * length };
}

function selectedSizeInfo() {
  if (state.selectedWall !== null && state.walls[state.selectedWall]) {
    return { lengthLabel: 'Selected wall length (ft)', length: feetValueFromInches(wallLengthInches(state.walls[state.selectedWall])) };
  }
  const shape = state.selectedShape !== null ? state.shapes[state.selectedShape] : null;
  if (!shape) return null;
  if (shape.type === 'line') return { lengthLabel: 'Selected line length (ft)', length: feetValueFromInches(wallLengthInches(shape)) };
  if (shape.type === 'square') return { lengthLabel: 'Selected side length (ft)', length: feetValueFromInches(pixelsToInches(Math.abs(shape.b.x - shape.a.x))) };
  if (shape.type === 'rectangle') return {
    lengthLabel: 'Selected width (ft)', length: feetValueFromInches(pixelsToInches(Math.abs(shape.b.x - shape.a.x))),
    heightLabel: 'Selected height (ft)', height: feetValueFromInches(pixelsToInches(Math.abs(shape.b.y - shape.a.y))),
  };
  return { lengthLabel: 'Selected diameter (ft)', length: feetValueFromInches(pixelsToInches(shape.radius * 2)) };
}

function applySelectedLength(feet) {
  const value = Number(feet); if (!Number.isFinite(value) || value <= 0) return;
  const snapshot = documentSnapshot();
  if (state.selectedWall !== null && state.walls[state.selectedWall]) setSegmentLength(state.walls[state.selectedWall], value);
  else if (state.selectedShape !== null && state.shapes[state.selectedShape]) {
    const shape = state.shapes[state.selectedShape];
    if (shape.type === 'line') setSegmentLength(shape, value);
    else if (shape.type === 'square') { setAxisLength(shape, 'x', value); setAxisLength(shape, 'y', value); }
    else if (shape.type === 'rectangle') setAxisLength(shape, 'x', value);
    else shape.radius = feetToPixels(value) / 2;
  } else return;
  pushHistory(snapshot); markDirty(); persist(); updateUi(); draw();
}

function applySelectedHeight(feet) {
  const value = Number(feet); if (!Number.isFinite(value) || value <= 0) return;
  if (state.selectedShape === null || !state.shapes[state.selectedShape] || state.shapes[state.selectedShape].type !== 'rectangle') return;
  const snapshot = documentSnapshot(); setAxisLength(state.shapes[state.selectedShape], 'y', value);
  pushHistory(snapshot); markDirty(); persist(); updateUi(); draw();
}

function renderWallList() {
  const list = $('#wallList'); list.replaceChildren();
  if (!state.walls.length) {
    const empty = document.createElement('li'); empty.className = 'empty-list';
    empty.textContent = 'Draw a wall to see its length.'; list.append(empty);
  } else state.walls.forEach((wall, index) => {
    const item = document.createElement('li'), name = document.createElement('span'), length = document.createElement('strong');
    name.textContent = `Line ${index + 1}`; length.textContent = formatLength(wallLengthInches(wall));
    item.append(name, length); list.append(item);
    item.addEventListener('click', () => { setTool('edit'); state.selectedWall = index; state.selectedShape = null; updateUi(); draw(); });
  });
  $('#totalLength').textContent = formatLength(state.walls.reduce((sum, wall) => sum + wallLengthInches(wall), 0));

  const rulerList = $('#rulerList'); rulerList.replaceChildren();
  if (!state.rulers.length) {
    const empty = document.createElement('li'); empty.className = 'empty-list'; empty.textContent = 'Measure between two points.'; rulerList.append(empty);
  } else state.rulers.forEach((ruler, index) => {
    const item = document.createElement('li'), name = document.createElement('span'), length = document.createElement('strong');
    name.textContent = 'Ruler ' + (index + 1); length.textContent = formatLength(wallLengthInches(ruler)); item.append(name, length); rulerList.append(item);
    item.addEventListener('click', () => { setTool('ruler'); state.selectedRuler = index; updateUi(); draw(); });
  });
  $('#rulerCount').textContent = String(state.rulers.length);

  const labelList = $('#labelList'); labelList.replaceChildren();
  if (!state.labels.length) {
    const empty = document.createElement('li'); empty.className = 'empty-list'; empty.textContent = 'Add text to see it here.'; labelList.append(empty);
  } else state.labels.forEach((label, index) => {
    const item = document.createElement('li'), name = document.createElement('span'), size = document.createElement('strong');
    name.textContent = label.text; name.title = label.text; size.textContent = `${label.fontSize || 16}px`;
    item.append(name, size); item.addEventListener('click', () => { setTool('text'); state.selectedLabel = index; updateUi(); draw(); });
    labelList.append(item);
  });
  $('#labelCount').textContent = String(state.labels.length);

  const shapeList = $('#shapeList'); shapeList.replaceChildren();
  if (!state.shapes.length) {
    const empty = document.createElement('li'); empty.className = 'empty-list'; empty.textContent = 'Add a shape to see it here.'; shapeList.append(empty);
  } else state.shapes.forEach((shape, index) => {
    const item = document.createElement('li'), name = document.createElement('span'), type = document.createElement('strong');
    name.textContent = `${shapeTypeLabel(shape)} ${index + 1}`; type.textContent = shapeSizeText(shape); item.append(name, type); shapeList.append(item);
    item.addEventListener('click', () => { setTool('shapes'); state.selectedShape = index; state.selectedWall = null; updateUi(); draw(); });
  });
  $('#shapeCount').textContent = String(state.shapes.length);
}

function updateUi() {
  $('#wallCount').textContent = `${state.walls.length} wall${state.walls.length === 1 ? '' : 's'}`;
  $('#undoButton').disabled = !state.history.length; $('#redoButton').disabled = !state.future.length;
  $('#gridSize').value = String(state.gridInches); $('#wallWidth').value = String(state.wallWidth);
  $('#wallWidthValue').textContent = `${state.wallWidth} in`; $('#zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#projectName').textContent = state.serverName || 'Untitled plan';
  $('#showText').checked = state.showText; $('#showDimensions').checked = state.showDimensions;
  const selectedWall = state.selectedWall !== null ? state.walls[state.selectedWall] : null;
  $('#wallWidth').disabled = !selectedWall;
  if (selectedWall) { $('#wallWidth').value = String(selectedWall.thickness || state.wallWidth); $('#wallWidthValue').textContent = (selectedWall.thickness || state.wallWidth) + ' in'; }
  else { $('#wallWidthValue').textContent = '—'; }
  const selectedLine = selectedLineElement();
  $('#lineColor').disabled = !selectedLine; $('#lineShade').disabled = !selectedLine;
  if (selectedLine) {
    const color = normalizeColor(selectedLine.item.color, selectedLine.fallback), shade = Math.round(normalizeShade(selectedLine.item.shade) * 100);
    $('#lineColor').value = color; $('#lineColorValue').textContent = color; $('#lineShade').value = String(shade); $('#lineShadeValue').textContent = `${shade}%`;
  } else { $('#lineColorValue').textContent = '—'; $('#lineShadeValue').textContent = '—'; }
  const sizeInfo = selectedSizeInfo();
  $('#elementLength').disabled = !sizeInfo; $('#elementHeight').disabled = !sizeInfo?.height;
  $('#elementLengthLabel').textContent = sizeInfo?.lengthLabel || 'Selected length (ft)'; $('#elementLength').value = sizeInfo?.length || '';
  $('#elementHeightLabel').textContent = sizeInfo?.heightLabel || 'Selected height (ft)'; $('#elementHeight').value = sizeInfo?.height || '';
  const selectedLabel = state.selectedLabel !== null ? state.labels[state.selectedLabel] : null;
  $('#labelSize').disabled = !selectedLabel;
  if (selectedLabel) { $('#labelSize').value = String(selectedLabel.fontSize || 16); $('#labelSizeValue').textContent = `${selectedLabel.fontSize || 16}px`; }
  else { $('#labelSizeValue').textContent = '—'; }
  renderWallList();
}

function setCanvasCursor() {
  canvas.style.cursor = state.panning || state.editingHandle || state.draggingLabel || state.rulerDragMode ? 'grabbing' : state.spacePressed || state.tool === 'pan' ? 'grab' : ['wall', 'ruler', 'shapes'].includes(state.tool) ? 'crosshair' : state.tool === 'edit' || state.tool === 'text' ? 'pointer' : 'cell';
}

function beginPan(event) {
  state.panning = true; state.panPointer = screenPoint(event); canvas.setPointerCapture(event.pointerId); setCanvasCursor();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1 || state.tool === 'pan' || state.spacePressed) { event.preventDefault(); beginPan(event); return; }
  if (event.button !== 0) return;
  const point = canvasPoint(event);
  if (state.tool === 'ruler') {
    let index = state.selectedRuler, part = index !== null && state.rulers[index] ? rulerPartAtEvent(event, state.rulers[index]) : null;
    if (!part) {
      index = -1;
      for (let i = state.rulers.length - 1; i >= 0; i -= 1) {
        part = rulerPartAtEvent(event, state.rulers[i]);
        if (part) { index = i; break; }
      }
    }
    if (part && index >= 0) {
      state.selectedRuler = index; state.rulerDragMode = part; state.rulerDragSnapshot = documentSnapshot();
      state.rulerDragStart = part === 'label' ? rawCanvasPoint(event) : point;
      state.rulerDragOriginal = structuredClone(state.rulers[index]);
      canvas.setPointerCapture(event.pointerId); setCanvasCursor(); draw(); return;
    }
    state.selectedRuler = null;
    state.drawingRuler = true; state.rulerStart = point; state.rulerPreview = { a: point, b: point };
    canvas.setPointerCapture(event.pointerId); draw(); return;
  }
  if (state.tool === 'shapes') {
    const raw = rawCanvasPoint(event), shapeIndex = shapeAtPoint(raw);
    if (shapeIndex >= 0) { state.selectedShape = shapeIndex; state.selectedWall = null; updateUi(); draw(); return; }
    state.selectedShape = null;
    state.drawingShape = true; state.shapeStart = point; state.shapePreview = shapeFromDrag(state.shapeKind, point, point);
    canvas.setPointerCapture(event.pointerId); draw(); return;
  }
  if (state.tool === 'text') {
    const rawPoint = rawCanvasPoint(event), index = labelAtPoint(rawPoint);
    if (index >= 0) {
      state.selectedLabel = index; state.draggingLabel = true; state.labelSnapshot = documentSnapshot();
      state.labelDragOffset = { x: rawPoint.x - state.labels[index].x, y: rawPoint.y - state.labels[index].y };
      canvas.setPointerCapture(event.pointerId); setCanvasCursor(); updateUi(); draw(); return;
    }
    const text = prompt('Enter label text:');
    if (text && text.trim()) {
      commitLabels([...state.labels, { text: text.trim().slice(0, 200), x: point.x, y: point.y, fontSize: 16 }]);
      state.selectedLabel = state.labels.length - 1; updateUi(); draw();
    } else { state.selectedLabel = null; updateUi(); draw(); }
    return;
  }
  if (state.tool === 'edit') {
    const rawPoint = rawCanvasPoint(event);
    let index = state.selectedWall;
    let handle = null;
    if (index !== null && state.walls[index]) {
      if (Math.hypot(rawPoint.x - state.walls[index].a.x, rawPoint.y - state.walls[index].a.y) < 14 / state.zoom) handle = 'a';
      else if (Math.hypot(rawPoint.x - state.walls[index].b.x, rawPoint.y - state.walls[index].b.y) < 14 / state.zoom) handle = 'b';
    }
    if (!handle) {
      index = -1;
      for (let i = state.walls.length - 1; i >= 0; i -= 1) {
        if (pointToSegmentDistance(rawPoint, state.walls[i].a, state.walls[i].b) < 18 / state.zoom) { index = i; break; }
      }
      state.selectedWall = index >= 0 ? index : null;
      if (state.selectedWall !== null) state.selectedShape = null;
    }
    if (handle) {
      state.editingHandle = handle; state.editSnapshot = documentSnapshot();
      canvas.setPointerCapture(event.pointerId); setCanvasCursor();
    }
    updateUi(); draw(); return;
  }
  if (state.tool === 'erase') {
    const raw = rawCanvasPoint(event);
    const labelIndex = labelAtPoint(raw);
    if (labelIndex >= 0) { commitLabels(state.labels.filter((_, i) => i !== labelIndex)); return; }
    let rulerIndex = -1;
    for (let i = state.rulers.length - 1; i >= 0; i -= 1) {
      if (pointToSegmentDistance(raw, state.rulers[i].a, state.rulers[i].b) < 12 / state.zoom) { rulerIndex = i; break; }
    }
    if (rulerIndex >= 0) { commitRulers(state.rulers.filter((_, i) => i !== rulerIndex)); return; }
    const shapeIndex = shapeAtPoint(raw);
    if (shapeIndex >= 0) { commitShapes(state.shapes.filter((_, i) => i !== shapeIndex)); return; }
    let index = -1;
    for (let i = state.walls.length - 1; i >= 0; i -= 1) {
      if (pointToSegmentDistance(raw, state.walls[i].a, state.walls[i].b) < 18 / state.zoom) { index = i; break; }
    }
    if (index >= 0) commit(state.walls.filter((_, i) => i !== index)); return;
  }
  state.drawing = true; state.start = point; state.preview = { a: point, b: point, thickness: state.wallWidth, color: DEFAULT_WALL_COLOR, shade: 1 }; canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (state.panning) {
    const point = screenPoint(event); state.offset.x += point.x - state.panPointer.x; state.offset.y += point.y - state.panPointer.y;
    state.panPointer = point; draw(); return;
  }
  if (state.rulerDragMode && state.selectedRuler !== null) {
    const ruler = state.rulers[state.selectedRuler];
    if (state.rulerDragMode === 'label') {
      const point = rawCanvasPoint(event), midpoint = { x: (ruler.a.x + ruler.b.x) / 2, y: (ruler.a.y + ruler.b.y) / 2 };
      ruler.labelOffset = { x: point.x - midpoint.x, y: point.y - midpoint.y };
    } else if (state.rulerDragMode === 'body') {
      const point = canvasPoint(event), dx = point.x - state.rulerDragStart.x, dy = point.y - state.rulerDragStart.y;
      ruler.a = { x: state.rulerDragOriginal.a.x + dx, y: state.rulerDragOriginal.a.y + dy };
      ruler.b = { x: state.rulerDragOriginal.b.x + dx, y: state.rulerDragOriginal.b.y + dy };
    } else {
      let point = canvasPoint(event);
      const other = state.rulerDragMode === 'a' ? ruler.b : ruler.a;
      if (event.shiftKey) {
        const dx = Math.abs(point.x - other.x), dy = Math.abs(point.y - other.y);
        point = dx > dy ? { x: point.x, y: other.y } : { x: other.x, y: point.y };
      }
      ruler[state.rulerDragMode] = point;
    }
    renderWallList(); draw(); return;
  }
  if (state.drawingRuler) {
    let point = canvasPoint(event);
    if (event.shiftKey) {
      const dx = Math.abs(point.x - state.rulerStart.x), dy = Math.abs(point.y - state.rulerStart.y);
      point = dx > dy ? { x: point.x, y: state.rulerStart.y } : { x: state.rulerStart.x, y: point.y };
    }
    state.rulerPreview = { a: state.rulerStart, b: point }; draw(); return;
  }
  if (state.drawingShape) {
    state.shapePreview = shapeFromDrag(state.shapeKind, state.shapeStart, canvasPoint(event)); draw(); return;
  }
  if (state.editingHandle && state.selectedWall !== null) {
    const point = canvasPoint(event);
    state.walls[state.selectedWall] = { ...state.walls[state.selectedWall], [state.editingHandle]: point };
    renderWallList(); draw(); return;
  }
  if (state.draggingLabel && state.selectedLabel !== null) {
    const rawPoint = rawCanvasPoint(event);
    state.labels[state.selectedLabel] = {
      ...state.labels[state.selectedLabel],
      x: snap(rawPoint.x - state.labelDragOffset.x), y: snap(rawPoint.y - state.labelDragOffset.y),
    };
    draw(); return;
  }
  if (!state.drawing) return;
  let point = canvasPoint(event);
  if (event.shiftKey) {
    const dx = Math.abs(point.x - state.start.x), dy = Math.abs(point.y - state.start.y);
    point = dx > dy ? { x: point.x, y: state.start.y } : { x: state.start.x, y: point.y };
  }
  state.preview = { a: state.start, b: point, thickness: state.wallWidth, color: DEFAULT_WALL_COLOR, shade: 1 }; draw();
});

function endPointer() {
  if (state.panning) { state.panning = false; state.panPointer = null; markDirty(); persist(); setCanvasCursor(); return; }
  if (state.rulerDragMode && state.selectedRuler !== null) {
    if (JSON.stringify(state.rulers) !== JSON.stringify(state.rulerDragSnapshot.rulers)) {
      pushHistory(state.rulerDragSnapshot); markDirty(); persist();
    }
    state.rulerDragMode = null; state.rulerDragSnapshot = null; state.rulerDragStart = null; state.rulerDragOriginal = null;
    updateUi(); draw(); setCanvasCursor(); return;
  }
  if (state.drawingRuler) {
    if (state.rulerPreview && !samePoint(state.rulerPreview.a, state.rulerPreview.b)) commitRulers([...state.rulers, state.rulerPreview]);
    state.drawingRuler = false; state.rulerStart = null; state.rulerPreview = null; draw(); return;
  }
  if (state.drawingShape) {
    const shape = state.shapePreview;
    const usable = shape && (shape.radius > 0 || (shape.a && shape.b && !samePoint(shape.a, shape.b)));
    if (usable) commitShapes([...state.shapes, shape]);
    state.drawingShape = false; state.shapeStart = null; state.shapePreview = null; draw(); return;
  }
  if (state.editingHandle && state.selectedWall !== null) {
    const wall = state.walls[state.selectedWall];
    const original = state.editSnapshot.walls[state.selectedWall];
    if (samePoint(wall.a, wall.b)) restoreSnapshot(state.editSnapshot);
    else if (!samePoint(wall.a, original.a) || !samePoint(wall.b, original.b)) {
      pushHistory(state.editSnapshot); markDirty(); persist();
    }
    state.editingHandle = null; state.editSnapshot = null; updateUi(); draw(); setCanvasCursor(); return;
  }
  if (state.draggingLabel && state.selectedLabel !== null) {
    const original = state.labelSnapshot.labels[state.selectedLabel], label = state.labels[state.selectedLabel];
    if (original.x !== label.x || original.y !== label.y) { pushHistory(state.labelSnapshot); markDirty(); persist(); }
    state.draggingLabel = false; state.labelSnapshot = null; state.labelDragOffset = null;
    updateUi(); draw(); setCanvasCursor(); return;
  }
  if (state.drawing && state.preview && !samePoint(state.preview.a, state.preview.b)) commit([...state.walls, state.preview]);
  state.drawing = false; state.start = null; state.preview = null; draw();
}
canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', (event) => {
  const index = labelAtPoint(rawCanvasPoint(event));
  if (index < 0) return;
  const text = prompt('Edit label text:', state.labels[index].text);
  if (text === null) return;
  if (!text.trim()) { state.selectedLabel = null; commitLabels(state.labels.filter((_, i) => i !== index)); return; }
  const labels = structuredClone(state.labels); labels[index].text = text.trim().slice(0, 200);
  commitLabels(labels); state.selectedLabel = index; updateUi(); draw();
});

function setTool(tool) {
  if (state.editingHandle && state.editSnapshot) restoreSnapshot(state.editSnapshot);
  if (state.draggingLabel && state.labelSnapshot) restoreSnapshot(state.labelSnapshot);
  if (state.rulerDragMode && state.rulerDragSnapshot) restoreSnapshot(state.rulerDragSnapshot);
  state.editingHandle = null; state.editSnapshot = null;
  state.draggingLabel = false; state.labelSnapshot = null; state.labelDragOffset = null;
  state.labelSizeSnapshot = null;
  state.wallSizeSnapshot = null;
  state.lineStyleSnapshot = null;
  state.rulerDragMode = null; state.rulerDragSnapshot = null; state.rulerDragStart = null; state.rulerDragOriginal = null;
  state.drawingRuler = false; state.rulerStart = null; state.rulerPreview = null;
  state.drawingShape = false; state.shapeStart = null; state.shapePreview = null;
  if (tool !== 'edit') state.selectedWall = null;
  if (tool !== 'shapes') state.selectedShape = null;
  if (tool !== 'text') state.selectedLabel = null;
  if (tool !== 'ruler') state.selectedRuler = null;
  state.tool = tool;
  $('#shapePalette').hidden = tool !== 'shapes';
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  const content = {
    wall: ['Wall tool', 'Drag between grid points · Hold Shift for a straight wall'],
    edit: ['Edit tool', 'Select a wall, then drag either endpoint'],
    ruler: ['Ruler tool', 'Drag to measure; select and drag a line, endpoint, or label'],
    shapes: ['Shapes tool', 'Choose a shape, then drag on the canvas'],
    text: ['Text tool', 'Click to add · Drag to move · Double-click to edit'],
    erase: ['Erase tool', 'Click a wall to remove it'], pan: ['Pan tool', 'Drag to move the grid and plan'],
  }[tool];
  $('#modeLabel').textContent = content[0]; $('#modeHelp').textContent = content[1]; setCanvasCursor(); updateUi(); draw();
}

function undo() {
  if (!state.history.length) return; state.future.push(documentSnapshot());
  restoreSnapshot(state.history.pop()); state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; markDirty(); persist(); draw(); updateUi();
}
function redo() {
  if (!state.future.length) return; state.history.push(documentSnapshot());
  restoreSnapshot(state.future.pop()); state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; markDirty(); persist(); draw(); updateUi();
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.download = 'gridline-floor-plan.json'; link.href = url; link.click(); URL.revokeObjectURL(url);
  state.dirty = false; persist(); updateUi();
}

const validPoint = (point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
function applyProject(project, options = {}) {
  if (!project || !Array.isArray(project.walls) || !project.walls.every((wall) => validPoint(wall.a) && validPoint(wall.b)))
    throw new Error('This file does not contain a valid Gridline floor plan.');
  if (project.labels !== undefined && (!Array.isArray(project.labels) || !project.labels.every((label) =>
    label && typeof label.text === 'string' && validPoint(label)))) throw new Error('This plan contains invalid text labels.');
  if (project.rulers !== undefined && (!Array.isArray(project.rulers) || !project.rulers.every((ruler) => validPoint(ruler.a) && validPoint(ruler.b))))
    throw new Error('This plan contains invalid rulers.');
  if (project.shapes !== undefined && (!Array.isArray(project.shapes) || !project.shapes.every((shape) => {
    if (!shape || !['square', 'rectangle', 'circle', 'line', 'semicircle'].includes(shape.type)) return false;
    return ['square', 'rectangle', 'line'].includes(shape.type) ? validPoint(shape.a) && validPoint(shape.b) : validPoint(shape.center) && Number.isFinite(Number(shape.radius));
  }))) throw new Error('This plan contains invalid shapes.');
  const legacyThickness = Number(project.settings?.wallWidth);
  state.walls = project.walls.map((wall) => {
    const thickness = Number(wall.thickness);
    const fallback = Number.isFinite(legacyThickness) ? Math.max(3, Math.min(12, legacyThickness)) : 6;
    return { a: { x: Number(wall.a.x), y: Number(wall.a.y) }, b: { x: Number(wall.b.x), y: Number(wall.b.y) }, thickness: Number.isFinite(thickness) ? Math.max(3, Math.min(12, thickness)) : fallback, color: normalizeColor(wall.color, DEFAULT_WALL_COLOR), shade: normalizeShade(wall.shade) };
  });
  state.labels = (project.labels || []).map((label) => {
    const size = Number(label.fontSize);
    return { text: label.text.slice(0, 200), x: Number(label.x), y: Number(label.y), fontSize: Number.isFinite(size) ? Math.max(10, Math.min(48, Math.round(size))) : 16 };
  });
  state.rulers = (project.rulers || []).map((ruler) => ({
    a: { x: Number(ruler.a.x), y: Number(ruler.a.y) }, b: { x: Number(ruler.b.x), y: Number(ruler.b.y) },
    ...(validPoint(ruler.labelOffset) ? { labelOffset: { x: Number(ruler.labelOffset.x), y: Number(ruler.labelOffset.y) } } : {}),
  }));
  state.shapes = (project.shapes || []).map((shape) => {
    const style = { color: normalizeColor(shape.color, DEFAULT_SHAPE_COLOR), shade: normalizeShade(shape.shade) };
    if (shape.type === 'square' || shape.type === 'rectangle' || shape.type === 'line') return { type: shape.type, a: { x: Number(shape.a.x), y: Number(shape.a.y) }, b: { x: Number(shape.b.x), y: Number(shape.b.y) }, ...style };
    return { type: shape.type, center: { x: Number(shape.center.x), y: Number(shape.center.y) }, radius: Math.max(0, Number(shape.radius)), ...style };
  });
  if ([3, 6, 12, 24].includes(Number(project.settings?.gridInches))) state.gridInches = Number(project.settings.gridInches);
  if (Number(project.settings?.wallWidth) >= 3 && Number(project.settings?.wallWidth) <= 12) state.wallWidth = Number(project.settings.wallWidth);
  state.showText = project.settings?.showText !== false; state.showDimensions = project.settings?.showDimensions !== false;
  state.grid = gridPixels(state.gridInches);
  if (Number.isFinite(Number(project.viewport?.zoom))) state.zoom = Math.max(.1, Math.min(2, Number(project.viewport.zoom)));
  if (validPoint(project.viewport?.offset)) state.offset = { x: Number(project.viewport.offset.x), y: Number(project.viewport.offset.y) };
  const fromServer = Object.prototype.hasOwnProperty.call(options, 'serverId');
  state.serverId = fromServer ? options.serverId : null;
  state.serverName = fromServer ? (options.serverName || 'Untitled plan') : 'Untitled plan';
  state.dirty = false;
  state.history = []; state.future = []; state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null;
  persist(); updateUi(); draw();
}

async function loadJson(file) {
  try {
    const project = JSON.parse(await file.text());
    applyProject(project); $('#saveStatus').textContent = `Loaded ${file.name}`;
  } catch (error) { alert(error.message || 'The selected file could not be loaded.'); }
  finally { $('#loadInput').value = ''; }
}

async function apiRequest(url, options) {
  const response = await fetch(url, options);
  let payload;
  try { payload = await response.json(); } catch (_) { throw new Error('The server returned an invalid response. Is PHP configured?'); }
  if (!response.ok) throw new Error(payload.error || `Server request failed (${response.status}).`);
  return payload;
}

async function saveServerPlan({ saveAsNew = false } = {}) {
  const name = prompt('Plan name:', state.serverName || 'Untitled plan');
  if (!name || !name.trim()) return false;
  try {
    $('#saveStatus').textContent = saveAsNew ? 'Saving new plan…' : 'Saving to server…';
    const payload = await apiRequest('./api.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: saveAsNew ? null : state.serverId, name: name.trim().slice(0, 100), plan: projectData() }),
    });
    state.serverId = payload.id; state.serverName = payload.name; state.dirty = false; persist(); updateUi();
    $('#saveStatus').textContent = 'Saved'; return true;
  } catch (error) { $('#saveStatus').textContent = 'Save failed'; alert(error.message); return false; }
}

async function openServerPlans() {
  const list = $('#serverPlanList'); list.replaceChildren();
  const loading = document.createElement('p'); loading.className = 'dialog-message'; loading.textContent = 'Loading plans…'; list.append(loading);
  $('#serverDialog').showModal();
  try {
    const payload = await apiRequest('./api.php'); list.replaceChildren();
    if (!payload.plans.length) {
      const empty = document.createElement('p'); empty.className = 'dialog-message'; empty.textContent = 'No plans have been saved on this server yet.'; list.append(empty); return;
    }
    payload.plans.forEach((plan) => {
      const button = document.createElement('button'), text = document.createElement('span'), date = document.createElement('small');
      text.textContent = plan.name; date.textContent = new Date(plan.updatedAt).toLocaleString(); button.append(text, date);
      button.addEventListener('click', async () => {
        try {
          const loaded = await apiRequest(`./api.php?id=${encodeURIComponent(plan.id)}`);
          applyProject(loaded.plan, { serverId: loaded.id, serverName: loaded.name });
          $('#serverDialog').close(); $('#saveStatus').textContent = 'Loaded from server';
        } catch (error) { alert(error.message); }
      });
      list.append(button);
    });
  } catch (error) { list.replaceChildren(); const message = document.createElement('p'); message.className = 'dialog-message error'; message.textContent = error.message; list.append(message); }
}

function resetProject() {
  state.walls = []; state.labels = []; state.rulers = []; state.shapes = []; state.history = []; state.future = [];
  state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; state.editingHandle = null; state.draggingLabel = false;
  state.start = null; state.preview = null; state.zoom = 1; state.offset = { x: 0, y: 0 };
  state.gridInches = 12; state.grid = gridPixels(12); state.wallWidth = 6;
  state.showText = true; state.showDimensions = true;
  state.serverId = null; state.serverName = 'Untitled plan'; state.dirty = false;
  persist(); updateUi(); draw(); setTool('wall'); $('#saveStatus').textContent = 'New project';
}

function requestNewProject() {
  if (!state.dirty) { resetProject(); return; }
  $('#newProjectDialog').showModal();
}

document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-shape]').forEach((button) => button.addEventListener('click', () => {
  state.shapeKind = button.dataset.shape;
  document.querySelectorAll('[data-shape]').forEach((choice) => choice.classList.toggle('active', choice === button));
  setTool('shapes');
}));
$('#undoButton').addEventListener('click', undo); $('#redoButton').addEventListener('click', redo);
$('#centerButton').addEventListener('click', () => { if (state.offset.x || state.offset.y) markDirty(); state.offset = { x: 0, y: 0 }; persist(); draw(); });
$('#clearButton').addEventListener('click', () => {
  if ((!state.walls.length && !state.labels.length && !state.rulers.length && !state.shapes.length) || !confirm('Clear the entire floor plan?')) return;
  pushHistory(); state.walls = []; state.labels = []; state.rulers = []; state.shapes = []; state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; markDirty(); persist(); updateUi(); draw();
});
$('#wallWidth').addEventListener('input', (event) => {
  if (state.selectedWall === null || !state.walls[state.selectedWall]) return;
  if (!state.wallSizeSnapshot) state.wallSizeSnapshot = documentSnapshot();
  state.walls[state.selectedWall].thickness = Number(event.target.value); markDirty();
  $('#wallWidthValue').textContent = event.target.value + ' in'; draw();
});
$('#wallWidth').addEventListener('change', () => {
  if (!state.wallSizeSnapshot) return;
  const previous = state.wallSizeSnapshot.walls[state.selectedWall]?.thickness || state.wallWidth;
  const current = state.walls[state.selectedWall]?.thickness || state.wallWidth;
  if (previous !== current) { pushHistory(state.wallSizeSnapshot); persist(); }
  state.wallSizeSnapshot = null; updateUi(); draw();
});
function commitLineStyleChange() {
  if (!state.lineStyleSnapshot) return;
  if (JSON.stringify(documentSnapshot()) !== JSON.stringify(state.lineStyleSnapshot)) { pushHistory(state.lineStyleSnapshot); persist(); }
  state.lineStyleSnapshot = null; updateUi(); draw();
}
$('#lineColor').addEventListener('input', (event) => {
  const selected = selectedLineElement(); if (!selected) return;
  if (!state.lineStyleSnapshot) state.lineStyleSnapshot = documentSnapshot();
  selected.item.color = normalizeColor(event.target.value, selected.fallback); markDirty();
  $('#lineColorValue').textContent = selected.item.color; draw();
});
$('#lineColor').addEventListener('change', commitLineStyleChange);
$('#lineShade').addEventListener('input', (event) => {
  const selected = selectedLineElement(); if (!selected) return;
  if (!state.lineStyleSnapshot) state.lineStyleSnapshot = documentSnapshot();
  selected.item.shade = normalizeShade(Number(event.target.value) / 100); markDirty();
  $('#lineShadeValue').textContent = `${Math.round(selected.item.shade * 100)}%`; draw();
});
$('#lineShade').addEventListener('change', commitLineStyleChange);
$('#elementLength').addEventListener('change', (event) => applySelectedLength(event.target.value));
$('#elementHeight').addEventListener('change', (event) => applySelectedHeight(event.target.value));
$('#labelSize').addEventListener('input', (event) => {
  if (state.selectedLabel === null || !state.labels[state.selectedLabel]) return;
  if (!state.labelSizeSnapshot) state.labelSizeSnapshot = documentSnapshot();
  state.labels[state.selectedLabel].fontSize = Number(event.target.value);
  markDirty();
  $('#labelSizeValue').textContent = `${event.target.value}px`; renderWallList(); draw();
});
$('#labelSize').addEventListener('change', () => {
  if (!state.labelSizeSnapshot) return;
  const previous = state.labelSizeSnapshot.labels[state.selectedLabel]?.fontSize || 16;
  const current = state.labels[state.selectedLabel]?.fontSize || 16;
  if (previous !== current) { pushHistory(state.labelSizeSnapshot); persist(); }
  state.labelSizeSnapshot = null; updateUi(); draw();
});
$('#gridSize').addEventListener('change', (event) => {
  const oldGrid = state.grid; state.gridInches = Number(event.target.value); state.grid = gridPixels(state.gridInches);
  const scale = state.grid / oldGrid;
  state.walls = state.walls.map((wall) => ({ ...wall, a: { x: wall.a.x * scale, y: wall.a.y * scale }, b: { x: wall.b.x * scale, y: wall.b.y * scale } }));
  state.labels = state.labels.map((label) => ({ ...label, x: label.x * scale, y: label.y * scale }));
  state.rulers = state.rulers.map((ruler) => ({ ...ruler, a: { x: ruler.a.x * scale, y: ruler.a.y * scale }, b: { x: ruler.b.x * scale, y: ruler.b.y * scale }, ...(ruler.labelOffset ? { labelOffset: { x: ruler.labelOffset.x * scale, y: ruler.labelOffset.y * scale } } : {}) }));
  state.shapes = state.shapes.map((shape) => shape.a ? { ...shape, a: { x: shape.a.x * scale, y: shape.a.y * scale }, b: { x: shape.b.x * scale, y: shape.b.y * scale } } : { ...shape, center: { x: shape.center.x * scale, y: shape.center.y * scale }, radius: shape.radius * scale });
  markDirty(); persist(); updateUi(); draw();
});
function setZoom(value, anchor = null) {
  const nextZoom = clampZoom(value);
  if (nextZoom === state.zoom) return;
  if (anchor) {
    const worldPoint = { x: (anchor.x - state.offset.x) / state.zoom, y: (anchor.y - state.offset.y) / state.zoom };
    state.offset = { x: anchor.x - worldPoint.x * nextZoom, y: anchor.y - worldPoint.y * nextZoom };
  }
  state.zoom = nextZoom; markDirty(); persist(); updateUi(); draw();
}
function handleWheelZoom(event) {
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
  setZoom(state.zoom * Math.exp(-delta * .001), screenPoint(event));
}
$('#showText').addEventListener('change', (event) => { state.showText = event.target.checked; markDirty(); persist(); draw(); });
$('#showDimensions').addEventListener('change', (event) => { state.showDimensions = event.target.checked; markDirty(); persist(); draw(); });
$('#zoomIn').addEventListener('click', () => setZoom(state.zoom + .25)); $('#zoomOut').addEventListener('click', () => setZoom(state.zoom - .25));
$('#saveButton').addEventListener('click', downloadJson); $('#loadButton').addEventListener('click', () => $('#loadInput').click());
$('#loadInput').addEventListener('change', (event) => event.target.files[0] && loadJson(event.target.files[0]));
$('#serverSaveButton').addEventListener('click', saveServerPlan);
$('#serverSaveNewButton').addEventListener('click', () => saveServerPlan({ saveAsNew: true }));
$('#serverLoadButton').addEventListener('click', openServerPlans);
$('#newProjectButton').addEventListener('click', requestNewProject);
$('#cancelNewProject').addEventListener('click', () => $('#newProjectDialog').close());
$('#cancelNewProjectIcon').addEventListener('click', () => $('#newProjectDialog').close());
$('#discardNewProject').addEventListener('click', () => { $('#newProjectDialog').close(); resetProject(); });
$('#saveNewProject').addEventListener('click', async () => {
  if (await saveServerPlan()) { $('#newProjectDialog').close(); resetProject(); }
});
$('#closeServerDialog').addEventListener('click', () => $('#serverDialog').close());
$('#serverDialog').addEventListener('click', (event) => { if (event.target === $('#serverDialog')) $('#serverDialog').close(); });
$('#exportButton').addEventListener('click', () => {
  const link = document.createElement('a'); link.download = 'gridline-floor-plan.png'; link.href = canvas.toDataURL('image/png'); link.click();
});
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !event.repeat) { state.spacePressed = true; setCanvasCursor(); event.preventDefault(); }
  if (event.key.toLowerCase() === 'w') setTool('wall'); if (event.key.toLowerCase() === 'v') setTool('edit'); if (event.key.toLowerCase() === 'r') setTool('ruler'); if (event.key.toLowerCase() === 's') setTool('shapes'); if (event.key.toLowerCase() === 't') setTool('text'); if (event.key.toLowerCase() === 'e') setTool('erase'); if (event.key.toLowerCase() === 'p') setTool('pan');
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.tool === 'text' && state.selectedLabel !== null) {
    event.preventDefault(); const selected = state.selectedLabel; state.selectedLabel = null; commitLabels(state.labels.filter((_, index) => index !== selected));
  }
  if (event.key === 'Escape') { state.selectedWall = null; state.selectedLabel = null; updateUi(); draw(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
});
window.addEventListener('keyup', (event) => { if (event.code === 'Space') { state.spacePressed = false; setCanvasCursor(); } });
window.addEventListener('blur', () => { state.spacePressed = false; if (!state.panning) setCanvasCursor(); });
window.addEventListener('beforeunload', (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
canvas.addEventListener('wheel', handleWheelZoom, { passive: false });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
new ResizeObserver(resize).observe(shell);
updateUi(); resize(); setTool('wall'); persist();
