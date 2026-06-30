const canvas = document.querySelector('#planCanvas');
const ctx = canvas.getContext('2d');
const shell = canvas.parentElement;
const $ = (selector) => document.querySelector(selector);
const gridPixels = (inches) => ({ 1: 12, 3: 20, 6: 25, 12: 32, 24: 44 })[inches] || 32;
const DEFAULT_WALL_COLOR = '#30332d';
const DEFAULT_SHAPE_COLOR = '#59615b';
const DEFAULT_LAYER_COLOR = '#30332d';
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
var elevationReady = false;
const OBJECT_DEFS = {
  car: { label: 'Car', src: './assets/car.svg', widthFt: 15, heightFt: 6 },
  person: { label: 'Person', src: './assets/person.svg', widthFt: 2, heightFt: 2 },
};

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
  walls: saved.walls || [], labels: saved.labels || [], rulers: saved.rulers || [], shapes: saved.shapes || [], objects: saved.objects || [], layers: saved.layers || [], history: [], future: [], tool: 'wall',
  drawing: false, panning: false, start: null, preview: null, panPointer: null, spacePressed: false,
  selectedWall: null, editingHandle: null, editSnapshot: null,
  selectedLabel: null, draggingLabel: false, labelSnapshot: null, labelDragOffset: null, labelSizeSnapshot: null,
  drawingRuler: false, rulerStart: null, rulerPreview: null,
  selectedRuler: null, rulerDragMode: null, rulerDragSnapshot: null, rulerDragStart: null, rulerDragOriginal: null,
  drawingShape: false, shapeStart: null, shapePreview: null, shapeKind: 'square', selectedShape: null,
  shapeDragMode: null, shapeDragSnapshot: null, shapeDragStart: null, shapeDragOriginal: null,
  objectKind: 'car', selectedObject: null, objectDragMode: null, objectDragSnapshot: null, objectDragStart: null, objectDragOriginal: null,
  wallSizeSnapshot: null, lineStyleSnapshot: null,
  selectMode: 'single', multiSelected: { walls: [], labels: [], rulers: [], shapes: [], objects: [] }, boxSelecting: false, boxStart: null, boxCurrent: null,
  multiDragSnapshot: null, multiDragStart: null, multiDragSelection: null, floorClipboard: null,
  editingLayerId: null, deletingLayerId: null,
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

const objectTintCache = new Map();
const objectImages = Object.fromEntries(Object.entries(OBJECT_DEFS).map(([key, def]) => {
  const image = new Image(); image.onload = () => { objectTintCache.clear(); draw(); }; image.src = def.src; return [key, image];
}));

const documentSnapshot = () => structuredClone({ walls: state.walls, labels: state.labels, rulers: state.rulers, shapes: state.shapes, objects: state.objects, layers: state.layers });
function restoreSnapshot(snapshot) {
  state.walls = structuredClone(snapshot.walls || []);
  state.labels = structuredClone(snapshot.labels || []);
  state.rulers = structuredClone(snapshot.rulers || []);
  state.shapes = structuredClone(snapshot.shapes || []);
  state.objects = structuredClone(snapshot.objects || []);
  state.layers = normalizeLayers(snapshot.layers || []);
  normalizeFloorLayerAssignments();
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
const normalizeLayerOpacity = (value) => Number.isFinite(Number(value)) ? clamp(Number(value), 0, 1) : 1;
function createLayerId() { return `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function normalizeLayerName(value, fallback) {
  const name = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return name || fallback;
}
function normalizeLayers(layers) {
  if (!Array.isArray(layers)) return [];
  const used = new Set();
  return layers.map((layer, index) => {
    let id = typeof layer?.id === 'string' && layer.id.trim() ? layer.id.trim().slice(0, 80) : createLayerId();
    while (used.has(id)) id = createLayerId();
    used.add(id);
    return {
      id,
      name: normalizeLayerName(layer?.name, `Layer ${index + 1}`),
      color: normalizeColor(layer?.color, DEFAULT_LAYER_COLOR),
      opacity: normalizeLayerOpacity(layer?.opacity),
      visible: layer?.visible !== false,
    };
  });
}
function normalizeLayerId(value, layers = state.layers) {
  return typeof value === 'string' && layers.some((layer) => layer.id === value) ? value : null;
}
function layerAssignmentId(value) {
  const id = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return id || null;
}
function layerForItem(item) { return state.layers.find((layer) => layer.id === layerAssignmentId(item?.layerId)) || null; }
function itemHasMissingLayer(item) { return !!layerAssignmentId(item?.layerId) && !layerForItem(item); }
function floorItemVisible(item) { const layer = layerForItem(item); return !layer || layer.visible !== false; }
function floorItemLayerStyle(item, fallbackColor, fallbackOpacity = 1) {
  const layer = layerForItem(item);
  if (layer) return { visible: layer.visible !== false, color: layer.color, opacity: normalizeLayerOpacity(layer.opacity) };
  if (itemHasMissingLayer(item)) return { visible: true, color: '#000000', opacity: 1 };
  return { visible: true, color: normalizeColor(item?.color, fallbackColor), opacity: fallbackOpacity };
}
function normalizeFloorLayerAssignments() {
  ['walls', 'labels', 'rulers', 'shapes', 'objects'].forEach((kind) => {
    state[kind] = (state[kind] || []).map((item) => ({ ...item, layerId: layerAssignmentId(item?.layerId) }));
  });
}
state.layers = normalizeLayers(state.layers);
normalizeFloorLayerAssignments();
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
  const style = preview ? { visible: true, color: '#b54b2d', opacity: .65 } : floorItemLayerStyle(wall, DEFAULT_WALL_COLOR, normalizeShade(wall.shade));
  if (!style.visible) return;
  ctx.save(); ctx.translate(state.offset.x, state.offset.y); ctx.scale(state.zoom, state.zoom);
  ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
  ctx.strokeStyle = style.color; ctx.globalAlpha = style.opacity;
  ctx.lineWidth = Math.max(2, (wall.thickness || state.wallWidth) / state.gridInches * state.grid);
  ctx.beginPath(); ctx.moveTo(wall.a.x, wall.a.y); ctx.lineTo(wall.b.x, wall.b.y); ctx.stroke();
  if (selected && !preview) { ctx.globalAlpha = 1; ctx.strokeStyle = '#b54b2d'; ctx.lineWidth = Math.max(3 / state.zoom, ctx.lineWidth + 2 / state.zoom); ctx.setLineDash([8 / state.zoom, 5 / state.zoom]); ctx.beginPath(); ctx.moveTo(wall.a.x, wall.a.y); ctx.lineTo(wall.b.x, wall.b.y); ctx.stroke(); }
  ctx.restore();
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
    const label = state.labels[i]; if (!floorItemVisible(label)) continue; const metrics = labelMetrics(label);
    if (Math.abs(point.x - label.x) <= metrics.width / 2 + 8 && Math.abs(point.y - label.y) <= metrics.height / 2 + 6) return i;
  }
  return -1;
}

function drawLabel(label, selected = false) {
  const style = floorItemLayerStyle(label, '#292b26', 1);
  if (!style.visible) return;
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
  ctx.globalAlpha = style.opacity; ctx.fillStyle = style.color; ctx.fillText(label.text, label.x, label.y); ctx.restore();
}
function rulerLabelWorldPosition(ruler) {
  const midpoint = { x: (ruler.a.x + ruler.b.x) / 2, y: (ruler.a.y + ruler.b.y) / 2 };
  if (ruler.labelOffset) return { x: midpoint.x + ruler.labelOffset.x, y: midpoint.y + ruler.labelOffset.y };
  const dx = ruler.b.x - ruler.a.x, dy = ruler.b.y - ruler.a.y, length = Math.hypot(dx, dy) || 1;
  return { x: midpoint.x - dy / length * (15 / state.zoom), y: midpoint.y + dx / length * (15 / state.zoom) };
}

function drawRuler(ruler, preview = false, selected = false) {
  const style = preview ? { visible: true, color: '#b54b2d', opacity: 1 } : floorItemLayerStyle(ruler, '#436b73', 1);
  if (!style.visible) return;
  const ax = state.offset.x + ruler.a.x * state.zoom, ay = state.offset.y + ruler.a.y * state.zoom;
  const bx = state.offset.x + ruler.b.x * state.zoom, by = state.offset.y + ruler.b.y * state.zoom;
  const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length, ny = dx / length;
  ctx.save(); ctx.globalAlpha = style.opacity;
  ctx.strokeStyle = selected ? '#b54b2d' : style.color; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
  [[ax, ay], [bx, by]].forEach(([x, y]) => { ctx.beginPath(); ctx.moveTo(x - nx * 6, y - ny * 6); ctx.lineTo(x + nx * 6, y + ny * 6); ctx.stroke(); });
  const labelPosition = rulerLabelWorldPosition(ruler);
  const label = formatLength(wallLengthInches(ruler)), x = state.offset.x + labelPosition.x * state.zoom, y = state.offset.y + labelPosition.y * state.zoom;
  ctx.font = '600 11px \"DM Sans\", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = selected ? '#a34329' : style.color; ctx.fillText(label, x, y + .5); ctx.restore();
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
  const style = preview ? { visible: true, color: '#b54b2d', opacity: .7 } : floorItemLayerStyle(shape, DEFAULT_SHAPE_COLOR, normalizeShade(shape.shade));
  if (!style.visible) return;
  ctx.save(); ctx.translate(state.offset.x, state.offset.y); ctx.scale(state.zoom, state.zoom);
  ctx.strokeStyle = style.color; ctx.globalAlpha = style.opacity;
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
function screenFromWorld(point) { return { x: state.offset.x + point.x * state.zoom, y: state.offset.y + point.y * state.zoom }; }

function drawScreenHandle(point) {
  const screen = screenFromWorld(point);
  ctx.save(); ctx.beginPath(); ctx.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#fffdf8'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#b54b2d'; ctx.stroke(); ctx.restore();
}

function radialHandle(shape) { return { x: shape.center.x + shape.radius, y: shape.center.y }; }

function drawShapeHandles(shape) {
  if (shape.type === 'line' || shape.type === 'square' || shape.type === 'rectangle') [shape.a, shape.b].forEach(drawScreenHandle);
  else { drawScreenHandle(shape.center); drawScreenHandle(radialHandle(shape)); }
}

function moveShape(shape, dx, dy) {
  if (shape.a) { shape.a = { x: shape.a.x + dx, y: shape.a.y + dy }; shape.b = { x: shape.b.x + dx, y: shape.b.y + dy }; }
  else shape.center = { x: shape.center.x + dx, y: shape.center.y + dy };
}

function shapePartAtEvent(event, shape) {
  const raw = rawCanvasPoint(event), near = (point) => Math.hypot(raw.x - point.x, raw.y - point.y) <= 12 / state.zoom;
  if (shape.type === 'line' || shape.type === 'square' || shape.type === 'rectangle') {
    if (near(shape.a)) return 'a'; if (near(shape.b)) return 'b';
  } else {
    if (near(radialHandle(shape))) return 'radius'; if (near(shape.center)) return 'body';
  }
  return shapeContainsPoint(shape, raw) ? 'body' : null;
}

function updateShapeDrag(event) {
  const shape = state.shapes[state.selectedShape], point = canvasPoint(event);
  if (!shape) return;
  if (state.shapeDragMode === 'body') {
    const dx = point.x - state.shapeDragStart.x, dy = point.y - state.shapeDragStart.y;
    Object.assign(shape, structuredClone(state.shapeDragOriginal)); moveShape(shape, dx, dy); return;
  }
  if (shape.type === 'circle' || shape.type === 'semicircle') {
    shape.radius = Math.max(1, Math.hypot(point.x - shape.center.x, point.y - shape.center.y)); return;
  }
  if (shape.type === 'square') {
    const anchor = state.shapeDragMode === 'a' ? state.shapeDragOriginal.b : state.shapeDragOriginal.a;
    const style = { color: shape.color, shade: shape.shade };
    Object.assign(shape, { ...shapeFromDrag('square', anchor, point), ...style }); return;
  }
  shape[state.shapeDragMode] = point;
}

function createObject(symbol, center) {
  const def = OBJECT_DEFS[symbol] || OBJECT_DEFS.car;
  return { symbol, x: center.x, y: center.y, width: feetToPixels(def.widthFt), height: feetToPixels(def.heightFt) };
}

function objectBounds(object) {
  return { x1: object.x - object.width / 2, y1: object.y - object.height / 2, x2: object.x + object.width / 2, y2: object.y + object.height / 2 };
}

function objectAtPoint(point) {
  for (let i = state.objects.length - 1; i >= 0; i -= 1) {
    if (!floorItemVisible(state.objects[i])) continue;
    const bounds = objectBounds(state.objects[i]);
    if (point.x >= bounds.x1 && point.x <= bounds.x2 && point.y >= bounds.y1 && point.y <= bounds.y2) return i;
  }
  return -1;
}

function objectPartAtEvent(event, object) {
  const raw = rawCanvasPoint(event), bounds = objectBounds(object), handle = { x: bounds.x2, y: bounds.y2 };
  if (Math.hypot(raw.x - handle.x, raw.y - handle.y) <= 12 / state.zoom) return 'resize';
  return raw.x >= bounds.x1 && raw.x <= bounds.x2 && raw.y >= bounds.y1 && raw.y <= bounds.y2 ? 'body' : null;
}


function tintedObjectImage(symbol, color) {
  const image = objectImages[symbol];
  if (!image?.complete || !image.naturalWidth) return null;
  const key = `${symbol}:${color}:${image.naturalWidth}x${image.naturalHeight}`;
  if (objectTintCache.has(key)) return objectTintCache.get(key);
  const tinted = document.createElement('canvas'); tinted.width = image.naturalWidth; tinted.height = image.naturalHeight;
  const tintCtx = tinted.getContext('2d'); tintCtx.drawImage(image, 0, 0);
  tintCtx.globalCompositeOperation = 'source-in'; tintCtx.fillStyle = color; tintCtx.fillRect(0, 0, tinted.width, tinted.height);
  objectTintCache.set(key, tinted); return tinted;
}
function drawObject(object, selected = false) {
  const style = floorItemLayerStyle(object, DEFAULT_SHAPE_COLOR, 1);
  if (!style.visible) return;
  const bounds = objectBounds(object), image = layerAssignmentId(object.layerId) ? tintedObjectImage(object.symbol, style.color) : objectImages[object.symbol], def = OBJECT_DEFS[object.symbol] || OBJECT_DEFS.car;
  ctx.save(); ctx.translate(state.offset.x, state.offset.y); ctx.scale(state.zoom, state.zoom); ctx.globalAlpha = style.opacity;
  if (image && ((image.complete && image.naturalWidth) || image instanceof HTMLCanvasElement)) ctx.drawImage(image, bounds.x1, bounds.y1, object.width, object.height);
  else {
    ctx.fillStyle = 'rgba(247,244,236,.8)'; ctx.strokeStyle = style.color; ctx.lineWidth = 2 / state.zoom;
    ctx.fillRect(bounds.x1, bounds.y1, object.width, object.height); ctx.strokeRect(bounds.x1, bounds.y1, object.width, object.height);
    ctx.fillStyle = '#292b26'; ctx.font = `${12 / state.zoom}px "DM Sans", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(def.label, object.x, object.y);
  }
  if (selected) { ctx.globalAlpha = 1; ctx.strokeStyle = '#b54b2d'; ctx.lineWidth = 1.5 / state.zoom; ctx.setLineDash([6 / state.zoom, 4 / state.zoom]); ctx.strokeRect(bounds.x1, bounds.y1, object.width, object.height); }
  ctx.restore();
  if (selected) drawScreenHandle({ x: bounds.x2, y: bounds.y2 });
}
function objectSizeText(object) { return `${formatLength(pixelsToInches(object.width))} ÃƒÆ’Ã¢â‚¬â€ ${formatLength(pixelsToInches(object.height))}`; }

function updateObjectDrag(event) {
  const object = state.objects[state.selectedObject]; if (!object) return;
  if (state.objectDragMode === 'body') {
    const point = canvasPoint(event), dx = point.x - state.objectDragStart.x, dy = point.y - state.objectDragStart.y;
    object.x = state.objectDragOriginal.x + dx; object.y = state.objectDragOriginal.y + dy; return;
  }
  const raw = rawCanvasPoint(event), minSize = feetToPixels(.5), aspect = state.objectDragOriginal.width / state.objectDragOriginal.height;
  let width = Math.max(minSize, Math.abs(raw.x - state.objectDragOriginal.x) * 2);
  let height = Math.max(minSize, Math.abs(raw.y - state.objectDragOriginal.y) * 2);
  if (event.shiftKey) { if (width / height > aspect) height = width / aspect; else width = height * aspect; }
  object.width = width; object.height = height;
}

function draw() {
  const width = canvas.width / state.dpr, height = canvas.height / state.dpr;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#e7e3d8'; ctx.fillRect(0, 0, width, height); drawGrid(width, height);
  state.shapes.forEach((shape, index) => drawShape(shape, false, (state.tool === 'shapes' && index === state.selectedShape) || floorSelectionIncludes('shapes', index)));
  state.objects.forEach((object, index) => drawObject(object, (state.tool === 'objects' && index === state.selectedObject) || floorSelectionIncludes('objects', index)));
  state.walls.forEach((wall, index) => drawWall(wall, false, (state.tool === 'edit' && index === state.selectedWall) || floorSelectionIncludes('walls', index)));
  if (state.showText) state.labels.forEach((label, index) => drawLabel(label, (state.tool === 'text' && index === state.selectedLabel) || floorSelectionIncludes('labels', index)));
  if (state.showDimensions) state.rulers.forEach((ruler, index) => drawRuler(ruler, false, (state.tool === 'ruler' && index === state.selectedRuler) || floorSelectionIncludes('rulers', index)));
  if (state.preview) drawWall(state.preview, true);
  if (state.rulerPreview) drawRuler(state.rulerPreview, true);
  if (state.shapePreview) drawShape(state.shapePreview, true);
  if (state.tool === 'shapes' && state.selectedShape !== null && state.shapes[state.selectedShape] && floorItemVisible(state.shapes[state.selectedShape])) drawShapeHandles(state.shapes[state.selectedShape]);
  if (state.tool === 'edit' && state.selectMode === 'single' && state.selectedWall !== null && state.walls[state.selectedWall] && floorItemVisible(state.walls[state.selectedWall])) drawEditHandles(state.walls[state.selectedWall]);
  drawFloorSelectionBox();
}

function projectData() {
  return {
    format: 'gridline-floor-plan', version: 8, exportedAt: new Date().toISOString(),
    settings: { gridInches: state.gridInches, wallWidth: state.wallWidth, showText: state.showText, showDimensions: state.showDimensions },
    viewport: { zoom: state.zoom, offset: { ...state.offset } },
    layers: state.layers.map((layer) => ({ id: layer.id, name: layer.name, color: normalizeColor(layer.color, DEFAULT_LAYER_COLOR), opacity: normalizeLayerOpacity(layer.opacity), visible: layer.visible !== false })),
    walls: state.walls.map((wall) => ({ a: { ...wall.a }, b: { ...wall.b }, thickness: wall.thickness || state.wallWidth, color: normalizeColor(wall.color, DEFAULT_WALL_COLOR), shade: normalizeShade(wall.shade), layerId: layerAssignmentId(wall.layerId) })),
    labels: state.labels.map((label) => ({ text: label.text, x: label.x, y: label.y, fontSize: label.fontSize || 16, layerId: layerAssignmentId(label.layerId) })),
    rulers: state.rulers.map((ruler) => ({ a: { ...ruler.a }, b: { ...ruler.b }, ...(ruler.labelOffset ? { labelOffset: { ...ruler.labelOffset } } : {}), layerId: layerAssignmentId(ruler.layerId) })),
    shapes: state.shapes.map((shape) => ({ ...structuredClone(shape), layerId: layerAssignmentId(shape.layerId) })),
    objects: state.objects.map((object) => ({ symbol: object.symbol, x: object.x, y: object.y, width: object.width, height: object.height, layerId: layerAssignmentId(object.layerId) })),
    elevations: elevationReady && typeof elevationProjectData === 'function' ? elevationProjectData() : (saved.elevations || null),
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

function commitObjects(nextObjects) {
  pushHistory(); state.objects = nextObjects; markDirty(); persist(); draw(); updateUi();
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
    if (!floorItemVisible(shape)) continue;
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

function shapeContainsPoint(shape, point) {
  const tolerance = 10 / state.zoom;
  if (shape.type === 'line') return pointToSegmentDistance(point, shape.a, shape.b) <= tolerance;
  if (shape.type === 'square' || shape.type === 'rectangle') {
    const x1 = Math.min(shape.a.x, shape.b.x), x2 = Math.max(shape.a.x, shape.b.x);
    const y1 = Math.min(shape.a.y, shape.b.y), y2 = Math.max(shape.a.y, shape.b.y);
    return point.x >= x1 - tolerance && point.x <= x2 + tolerance && point.y >= y1 - tolerance && point.y <= y2 + tolerance;
  }
  if (shape.type === 'circle') return Math.hypot(point.x - shape.center.x, point.y - shape.center.y) <= shape.radius + tolerance;
  return point.y <= shape.center.y + tolerance && point.x >= shape.center.x - shape.radius - tolerance && point.x <= shape.center.x + shape.radius + tolerance && point.y >= shape.center.y - shape.radius - tolerance;
}

function emptyFloorSelection() { return { walls: [], labels: [], rulers: [], shapes: [], objects: [] }; }
function floorSelectionCount(selection = state.multiSelected) { return Object.values(selection).reduce((total, items) => total + items.length, 0); }
function hasFloorMultiSelection() { return floorSelectionCount() > 0; }
function clearFloorMultiSelection() { state.multiSelected = emptyFloorSelection(); }
function clearFloorSingleSelection() { state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; state.selectedObject = null; }
function floorSelectionIncludes(kind, index) { return state.multiSelected[kind]?.includes(index); }
function normalizedRect(a, b) { return { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) }; }
function boundsFromPoints(points) { return points.reduce((box, point) => ({ x1: Math.min(box.x1, point.x), y1: Math.min(box.y1, point.y), x2: Math.max(box.x2, point.x), y2: Math.max(box.y2, point.y) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }); }
function labelBounds(label) { const metrics = labelMetrics(label); return { x1: label.x - metrics.width / 2 - 7, y1: label.y - metrics.height / 2 - 4, x2: label.x + metrics.width / 2 + 7, y2: label.y + metrics.height / 2 + 4 }; }
function shapeBounds(shape) { if (shape.a) return boundsFromPoints([shape.a, shape.b]); if (shape.type === 'semicircle') return { x1: shape.center.x - shape.radius, y1: shape.center.y - shape.radius, x2: shape.center.x + shape.radius, y2: shape.center.y }; return { x1: shape.center.x - shape.radius, y1: shape.center.y - shape.radius, x2: shape.center.x + shape.radius, y2: shape.center.y + shape.radius }; }
function floorItemBounds(kind, item) { if (kind === 'walls' || kind === 'rulers') return boundsFromPoints([item.a, item.b]); if (kind === 'labels') return labelBounds(item); if (kind === 'shapes') return shapeBounds(item); if (kind === 'objects') return objectBounds(item); return null; }
function rectContainsBounds(rect, bounds) { return bounds && bounds.x1 >= rect.x1 && bounds.y1 >= rect.y1 && bounds.x2 <= rect.x2 && bounds.y2 <= rect.y2; }
function selectFloorItemsInRect(a, b) { const rect = normalizedRect(a, b), selection = emptyFloorSelection(); state.walls.forEach((item, index) => { if (floorItemVisible(item) && rectContainsBounds(rect, floorItemBounds('walls', item))) selection.walls.push(index); }); state.labels.forEach((item, index) => { if (floorItemVisible(item) && rectContainsBounds(rect, floorItemBounds('labels', item))) selection.labels.push(index); }); state.rulers.forEach((item, index) => { if (floorItemVisible(item) && rectContainsBounds(rect, floorItemBounds('rulers', item))) selection.rulers.push(index); }); state.shapes.forEach((item, index) => { if (floorItemVisible(item) && rectContainsBounds(rect, floorItemBounds('shapes', item))) selection.shapes.push(index); }); state.objects.forEach((item, index) => { if (floorItemVisible(item) && rectContainsBounds(rect, floorItemBounds('objects', item))) selection.objects.push(index); }); return selection; }
function drawFloorSelectionBox() { if (!state.boxSelecting || !state.boxStart || !state.boxCurrent) return; const a = screenFromWorld(state.boxStart), b = screenFromWorld(state.boxCurrent), rect = normalizedRect(a, b); ctx.save(); ctx.fillStyle = 'rgba(181,75,45,.12)'; ctx.strokeStyle = '#b54b2d'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.fillRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1); ctx.strokeRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1); ctx.restore(); }
function floorSelectedItemAtEvent(event) { const raw = rawCanvasPoint(event); const objectIndex = objectAtPoint(raw); if (state.multiSelected.objects.includes(objectIndex)) return true; const labelIndex = labelAtPoint(raw); if (state.multiSelected.labels.includes(labelIndex)) return true; if (state.multiSelected.shapes.some((index) => state.shapes[index] && floorItemVisible(state.shapes[index]) && shapePartAtEvent(event, state.shapes[index]))) return true; if (state.multiSelected.rulers.some((index) => state.rulers[index] && floorItemVisible(state.rulers[index]) && rulerPartAtEvent(event, state.rulers[index]))) return true; return state.multiSelected.walls.some((index) => state.walls[index] && floorItemVisible(state.walls[index]) && pointToSegmentDistance(raw, state.walls[index].a, state.walls[index].b) < 18 / state.zoom); }
function moveFloorSelectionBy(selection, dx, dy) { selection.walls.forEach((index) => { const item = state.walls[index]; if (item) { item.a = { x: item.a.x + dx, y: item.a.y + dy }; item.b = { x: item.b.x + dx, y: item.b.y + dy }; } }); selection.labels.forEach((index) => { const item = state.labels[index]; if (item) { item.x += dx; item.y += dy; } }); selection.rulers.forEach((index) => { const item = state.rulers[index]; if (item) { item.a = { x: item.a.x + dx, y: item.a.y + dy }; item.b = { x: item.b.x + dx, y: item.b.y + dy }; } }); selection.shapes.forEach((index) => { const item = state.shapes[index]; if (item) moveShape(item, dx, dy); }); selection.objects.forEach((index) => { const item = state.objects[index]; if (item) { item.x += dx; item.y += dy; } }); }
function offsetFloorItem(kind, item, offset) { const clone = structuredClone(item); if (kind === 'walls' || kind === 'rulers') { clone.a = { x: clone.a.x + offset, y: clone.a.y + offset }; clone.b = { x: clone.b.x + offset, y: clone.b.y + offset }; } else if (kind === 'labels') { clone.x += offset; clone.y += offset; } else if (kind === 'shapes') moveShape(clone, offset, offset); else if (kind === 'objects') { clone.x += offset; clone.y += offset; } return clone; }
function singleFloorSelection() { const selection = emptyFloorSelection(); if (state.selectedWall !== null && state.walls[state.selectedWall]) selection.walls.push(state.selectedWall); if (state.selectedLabel !== null && state.labels[state.selectedLabel]) selection.labels.push(state.selectedLabel); if (state.selectedRuler !== null && state.rulers[state.selectedRuler]) selection.rulers.push(state.selectedRuler); if (state.selectedShape !== null && state.shapes[state.selectedShape]) selection.shapes.push(state.selectedShape); if (state.selectedObject !== null && state.objects[state.selectedObject]) selection.objects.push(state.selectedObject); return selection; }
function copyFloorSelection() { const selection = hasFloorMultiSelection() ? state.multiSelected : singleFloorSelection(); if (!floorSelectionCount(selection)) return false; state.floorClipboard = { walls: selection.walls.map((index) => structuredClone(state.walls[index])), labels: selection.labels.map((index) => structuredClone(state.labels[index])), rulers: selection.rulers.map((index) => structuredClone(state.rulers[index])), shapes: selection.shapes.map((index) => structuredClone(state.shapes[index])), objects: selection.objects.map((index) => structuredClone(state.objects[index])) }; return true; }
function pasteFloorClipboard() { const clip = state.floorClipboard; if (!clip || !Object.values(clip).some((items) => items.length)) return false; const snapshot = documentSnapshot(), offset = state.grid * 2, selection = emptyFloorSelection(); clip.walls.forEach((item) => { selection.walls.push(state.walls.push(offsetFloorItem('walls', item, offset)) - 1); }); clip.labels.forEach((item) => { selection.labels.push(state.labels.push(offsetFloorItem('labels', item, offset)) - 1); }); clip.rulers.forEach((item) => { selection.rulers.push(state.rulers.push(offsetFloorItem('rulers', item, offset)) - 1); }); clip.shapes.forEach((item) => { selection.shapes.push(state.shapes.push(offsetFloorItem('shapes', item, offset)) - 1); }); clip.objects.forEach((item) => { selection.objects.push(state.objects.push(offsetFloorItem('objects', item, offset)) - 1); }); pushHistory(snapshot); markDirty(); persist(); setTool('edit'); state.selectMode = 'highlight'; clearFloorSingleSelection(); state.multiSelected = selection; syncSelectModeUi(); updateUi(); draw(); return true; }
function deleteFloorSelection() { const selection = hasFloorMultiSelection() ? state.multiSelected : singleFloorSelection(); if (!floorSelectionCount(selection)) return false; const snapshot = documentSnapshot(), omit = (items, selected) => { const set = new Set(selected); return items.filter((_, index) => !set.has(index)); }; state.walls = omit(state.walls, selection.walls); state.labels = omit(state.labels, selection.labels); state.rulers = omit(state.rulers, selection.rulers); state.shapes = omit(state.shapes, selection.shapes); state.objects = omit(state.objects, selection.objects); clearFloorSingleSelection(); clearFloorMultiSelection(); pushHistory(snapshot); markDirty(); persist(); updateUi(); draw(); return true; }
function syncSelectModeUi() { const palette = $('#selectPalette'); if (palette) palette.hidden = state.tool !== 'edit'; document.querySelectorAll('[data-select-mode]').forEach((button) => button.classList.toggle('active', button.dataset.selectMode === state.selectMode)); }
function isTypingTarget(target) { return target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable); }
function shapeTypeLabel(shape) { return shape.type === 'semicircle' ? 'semi-circle' : shape.type; }

function shapeSizeText(shape) {
  if (shape.type === 'line') return formatLength(wallLengthInches(shape));
  if (shape.type === 'square' || shape.type === 'rectangle') {
    const width = formatLength(pixelsToInches(Math.abs(shape.b.x - shape.a.x)));
    const height = formatLength(pixelsToInches(Math.abs(shape.b.y - shape.a.y)));
    return `${width} ÃƒÆ’Ã¢â‚¬â€ ${height}`;
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
  const object = state.selectedObject !== null ? state.objects[state.selectedObject] : null;
  if (object) return {
    lengthLabel: 'Selected object width (ft)', length: feetValueFromInches(pixelsToInches(object.width)),
    heightLabel: 'Selected object height (ft)', height: feetValueFromInches(pixelsToInches(object.height)),
  };
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
  else if (state.selectedObject !== null && state.objects[state.selectedObject]) state.objects[state.selectedObject].width = feetToPixels(value);
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
  if (state.selectedObject !== null && state.objects[state.selectedObject]) {
    const snapshot = documentSnapshot(); state.objects[state.selectedObject].height = feetToPixels(value);
    pushHistory(snapshot); markDirty(); persist(); updateUi(); draw(); return;
  }
  if (state.selectedShape === null || !state.shapes[state.selectedShape] || state.shapes[state.selectedShape].type !== 'rectangle') return;
  const snapshot = documentSnapshot(); setAxisLength(state.shapes[state.selectedShape], 'y', value);
  pushHistory(snapshot); markDirty(); persist(); updateUi(); draw();
}


function selectedFloorItemsForLayer() {
  const selection = hasFloorMultiSelection() ? state.multiSelected : singleFloorSelection();
  return Object.entries(selection).flatMap(([kind, indexes]) => indexes.map((index) => state[kind][index]).filter(Boolean));
}

function selectedLayerValue() {
  const items = selectedFloorItemsForLayer();
  if (!items.length) return { value: '', mixed: false, missing: false, count: 0 };
  const values = [...new Set(items.map((item) => layerAssignmentId(item.layerId) || ''))];
  const value = values.length === 1 ? values[0] : '__mixed__';
  return { value, mixed: values.length > 1, missing: value && value !== '__mixed__' && !normalizeLayerId(value), count: items.length };
}

function renderLayerControls() {
  const select = $('#layerSelect'), list = $('#layerList');
  if (!select || !list) return;
  const current = selectedLayerValue();
  select.replaceChildren();
  if (!current.count) {
    const option = document.createElement('option'); option.value = ''; option.textContent = 'No selection'; select.append(option); select.disabled = true;
  } else {
    if (current.mixed) {
      const mixed = document.createElement('option'); mixed.value = '__mixed__'; mixed.textContent = 'Mixed layers'; mixed.disabled = true; select.append(mixed);
    } else if (current.missing) {
      const missing = document.createElement('option'); missing.value = current.value; missing.textContent = 'Missing layer (black)'; missing.disabled = true; select.append(missing);
    }
    const unassigned = document.createElement('option'); unassigned.value = ''; unassigned.textContent = 'Not assigned'; select.append(unassigned);
    state.layers.forEach((layer) => { const option = document.createElement('option'); option.value = layer.id; option.textContent = layer.name; select.append(option); });
    select.disabled = false; select.value = current.value;
  }

  list.replaceChildren();
  if (!state.layers.length) {
    const empty = document.createElement('p'); empty.className = 'layer-empty'; empty.textContent = 'No layers yet. Add a layer, then assign selected items to it.'; list.append(empty); return;
  }
  state.layers.forEach((layer) => {
    const row = document.createElement('div'); row.className = 'layer-row';
    const visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = layer.visible !== false; visible.title = 'Show layer';
    const swatch = document.createElement('span'); swatch.className = 'layer-swatch'; swatch.style.backgroundColor = layer.color; swatch.style.opacity = String(normalizeLayerOpacity(layer.opacity));
    const meta = document.createElement('div'); meta.className = 'layer-meta';
    const name = document.createElement('strong'); name.textContent = layer.name;
    const details = document.createElement('small'); details.textContent = `${Math.round(normalizeLayerOpacity(layer.opacity) * 100)}% opacity`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button layer-delete'; remove.textContent = '×'; remove.title = 'Delete layer'; remove.setAttribute('aria-label', `Delete ${layer.name}`);
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'text-button'; edit.textContent = 'Edit';
    meta.append(name, details); row.append(visible, swatch, meta, remove, edit); list.append(row);
    visible.addEventListener('change', () => setLayerVisibility(layer.id, visible.checked));
    remove.addEventListener('click', () => openDeleteLayerDialog(layer.id));
    edit.addEventListener('click', () => openLayerDialog(layer.id));
  });
}

function createLayer() {
  const snapshot = documentSnapshot();
  const layer = { id: createLayerId(), name: `Layer ${state.layers.length + 1}`, color: DEFAULT_LAYER_COLOR, opacity: 1, visible: true };
  state.layers.push(layer); pushHistory(snapshot); markDirty(); persist(); updateUi(); draw(); openLayerDialog(layer.id);
}

function setLayerVisibility(id, visible) {
  const layer = state.layers.find((item) => item.id === id); if (!layer || layer.visible === visible) return;
  const snapshot = documentSnapshot(); layer.visible = visible; pushHistory(snapshot); markDirty(); persist(); updateUi(); draw();
}

function applyLayerToSelection(id) {
  const items = selectedFloorItemsForLayer(); if (!items.length) return;
  const layerId = normalizeLayerId(id);
  if (items.every((item) => (layerAssignmentId(item.layerId) || '') === (layerId || ''))) return;
  const snapshot = documentSnapshot(); items.forEach((item) => { item.layerId = layerId; });
  pushHistory(snapshot); markDirty(); persist(); updateUi(); draw();
}


function countLayerAssignments(id) {
  return ['walls', 'labels', 'rulers', 'shapes', 'objects'].reduce((total, kind) => total + state[kind].filter((item) => layerAssignmentId(item.layerId) === id).length, 0);
}

function openDeleteLayerDialog(id) {
  const layer = state.layers.find((item) => item.id === id); if (!layer) return;
  state.deletingLayerId = id;
  const count = countLayerAssignments(id);
  $('#deleteLayerMessage').textContent = `Delete "${layer.name}"? ${count} assigned item${count === 1 ? '' : 's'} will remain on the canvas and render black at 100% opacity until reassigned.`;
  $('#deleteLayerDialog').showModal();
}

function closeDeleteLayerDialog() { state.deletingLayerId = null; $('#deleteLayerDialog').close(); }

function confirmDeleteLayer() {
  const id = state.deletingLayerId;
  if (!id || !state.layers.some((layer) => layer.id === id)) { closeDeleteLayerDialog(); return; }
  const snapshot = documentSnapshot();
  state.layers = state.layers.filter((layer) => layer.id !== id);
  if (state.editingLayerId === id && $('#layerDialog').open) closeLayerDialog();
  pushHistory(snapshot); markDirty(); persist(); updateUi(); draw(); closeDeleteLayerDialog();
}
function openLayerDialog(id) {
  const layer = state.layers.find((item) => item.id === id); if (!layer) return;
  state.editingLayerId = id;
  $('#layerName').value = layer.name;
  $('#layerColor').value = normalizeColor(layer.color, DEFAULT_LAYER_COLOR);
  $('#layerColorValue').textContent = $('#layerColor').value;
  $('#layerOpacity').value = String(Math.round(normalizeLayerOpacity(layer.opacity) * 100));
  $('#layerOpacityValue').textContent = `${$('#layerOpacity').value}%`;
  $('#layerDialog').showModal();
}

function closeLayerDialog() { state.editingLayerId = null; $('#layerDialog').close(); }

function saveLayerDialog() {
  const layer = state.layers.find((item) => item.id === state.editingLayerId); if (!layer) { closeLayerDialog(); return; }
  const next = {
    name: normalizeLayerName($('#layerName').value, layer.name),
    color: normalizeColor($('#layerColor').value, DEFAULT_LAYER_COLOR),
    opacity: normalizeLayerOpacity(Number($('#layerOpacity').value) / 100),
  };
  if (layer.name === next.name && layer.color === next.color && normalizeLayerOpacity(layer.opacity) === next.opacity) { closeLayerDialog(); return; }
  const snapshot = documentSnapshot(); Object.assign(layer, next);
  pushHistory(snapshot); markDirty(); persist(); updateUi(); draw(); closeLayerDialog();
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
    item.addEventListener('click', () => { setTool('edit'); state.selectedWall = index; state.selectedShape = null; state.selectedObject = null; updateUi(); draw(); });
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
    item.addEventListener('click', () => { setTool('shapes'); state.selectedShape = index; state.selectedWall = null; state.selectedObject = null; updateUi(); draw(); });
  });
  $('#shapeCount').textContent = String(state.shapes.length);

  const objectList = $('#objectList'); objectList.replaceChildren();
  if (!state.objects.length) {
    const empty = document.createElement('li'); empty.className = 'empty-list'; empty.textContent = 'Add a car or person to see it here.'; objectList.append(empty);
  } else state.objects.forEach((object, index) => {
    const item = document.createElement('li'), name = document.createElement('span'), size = document.createElement('strong');
    name.textContent = `${OBJECT_DEFS[object.symbol]?.label || object.symbol} ${index + 1}`; size.textContent = objectSizeText(object); item.append(name, size); objectList.append(item);
    item.addEventListener('click', () => { setTool('objects'); state.selectedObject = index; state.selectedShape = null; state.selectedWall = null; updateUi(); draw(); });
  });
  $('#objectCount').textContent = String(state.objects.length);
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
  else { $('#wallWidthValue').textContent = 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'; }
  const selectedLine = selectedLineElement();
  const selectedLineLayer = selectedLine ? layerForItem(selectedLine.item) : null;
  const selectedLineMissingLayer = selectedLine ? itemHasMissingLayer(selectedLine.item) : false;
  $('#lineColor').disabled = !selectedLine || !!selectedLineLayer || selectedLineMissingLayer; $('#lineShade').disabled = !selectedLine || !!selectedLineLayer || selectedLineMissingLayer;
  if (selectedLineLayer) {
    const shade = Math.round(normalizeLayerOpacity(selectedLineLayer.opacity) * 100);
    $('#lineColor').value = selectedLineLayer.color; $('#lineColorValue').textContent = 'Layer'; $('#lineShade').value = String(shade); $('#lineShadeValue').textContent = `${shade}%`;
  } else if (selectedLineMissingLayer) {
    $('#lineColor').value = '#000000'; $('#lineColorValue').textContent = 'Missing'; $('#lineShade').value = '100'; $('#lineShadeValue').textContent = '100%';
  } else if (selectedLine) {
    const color = normalizeColor(selectedLine.item.color, selectedLine.fallback), shade = Math.round(normalizeShade(selectedLine.item.shade) * 100);
    $('#lineColor').value = color; $('#lineColorValue').textContent = color; $('#lineShade').value = String(shade); $('#lineShadeValue').textContent = `${shade}%`;
  } else { $('#lineColorValue').textContent = 'â€”'; $('#lineShadeValue').textContent = 'â€”'; }
  const sizeInfo = selectedSizeInfo();
  $('#elementLength').disabled = !sizeInfo; $('#elementHeight').disabled = !sizeInfo?.height;
  $('#elementLengthLabel').textContent = sizeInfo?.lengthLabel || 'Selected length (ft)'; $('#elementLength').value = sizeInfo?.length || '';
  $('#elementHeightLabel').textContent = sizeInfo?.heightLabel || 'Selected height (ft)'; $('#elementHeight').value = sizeInfo?.height || '';
  const selectedLabel = state.selectedLabel !== null ? state.labels[state.selectedLabel] : null;
  $('#labelSize').disabled = !selectedLabel;
  if (selectedLabel) { $('#labelSize').value = String(selectedLabel.fontSize || 16); $('#labelSizeValue').textContent = `${selectedLabel.fontSize || 16}px`; }
  else { $('#labelSizeValue').textContent = 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'; }
  renderLayerControls();
  renderWallList();
}

function setCanvasCursor() {
  canvas.style.cursor = state.panning || state.editingHandle || state.draggingLabel || state.rulerDragMode || state.shapeDragMode || state.objectDragMode ? 'grabbing' : state.spacePressed || state.tool === 'pan' ? 'grab' : ['wall', 'ruler', 'shapes', 'objects'].includes(state.tool) ? 'crosshair' : state.tool === 'edit' || state.tool === 'text' ? 'pointer' : 'cell';
}

function beginPan(event) {
  state.panning = true; state.panPointer = screenPoint(event); canvas.setPointerCapture(event.pointerId); setCanvasCursor();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1 || state.tool === 'pan' || state.spacePressed) { event.preventDefault(); beginPan(event); return; }
  if (event.button !== 0) return;
  const point = canvasPoint(event);
  if (state.tool === 'ruler') {
    let index = state.selectedRuler, part = index !== null && state.rulers[index] && floorItemVisible(state.rulers[index]) ? rulerPartAtEvent(event, state.rulers[index]) : null;
    if (!part) {
      index = -1;
      for (let i = state.rulers.length - 1; i >= 0; i -= 1) {
        if (!floorItemVisible(state.rulers[i])) continue;
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
    let index = state.selectedShape, part = index !== null && state.shapes[index] && floorItemVisible(state.shapes[index]) ? shapePartAtEvent(event, state.shapes[index]) : null;
    if (!part) {
      index = -1;
      for (let i = state.shapes.length - 1; i >= 0; i -= 1) { if (!floorItemVisible(state.shapes[i])) continue; part = shapePartAtEvent(event, state.shapes[i]); if (part) { index = i; break; } }
    }
    if (part && index >= 0) {
      state.selectedShape = index; state.selectedWall = null; state.selectedObject = null; state.shapeDragMode = part; state.shapeDragSnapshot = documentSnapshot();
      state.shapeDragStart = canvasPoint(event); state.shapeDragOriginal = structuredClone(state.shapes[index]);
      canvas.setPointerCapture(event.pointerId); setCanvasCursor(); updateUi(); draw(); return;
    }
    state.selectedShape = null;
    state.drawingShape = true; state.shapeStart = point; state.shapePreview = shapeFromDrag(state.shapeKind, point, point);
    canvas.setPointerCapture(event.pointerId); draw(); return;
  }
  if (state.tool === 'objects') {
    let index = state.selectedObject, part = index !== null && state.objects[index] && floorItemVisible(state.objects[index]) ? objectPartAtEvent(event, state.objects[index]) : null;
    if (!part) { index = objectAtPoint(rawCanvasPoint(event)); part = index >= 0 ? objectPartAtEvent(event, state.objects[index]) : null; }
    if (part && index >= 0) {
      state.selectedObject = index; state.selectedShape = null; state.selectedWall = null; state.objectDragMode = part; state.objectDragSnapshot = documentSnapshot();
      state.objectDragStart = canvasPoint(event); state.objectDragOriginal = structuredClone(state.objects[index]);
      canvas.setPointerCapture(event.pointerId); setCanvasCursor(); updateUi(); draw(); return;
    }
    const snapshot = documentSnapshot(); state.objects.push(createObject(state.objectKind, point)); state.selectedObject = state.objects.length - 1; state.selectedShape = null; state.selectedWall = null;
    pushHistory(snapshot); markDirty(); persist(); updateUi(); draw(); return;
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
    if (index !== null && state.walls[index] && floorItemVisible(state.walls[index])) {
      if (Math.hypot(rawPoint.x - state.walls[index].a.x, rawPoint.y - state.walls[index].a.y) < 14 / state.zoom) handle = 'a';
      else if (Math.hypot(rawPoint.x - state.walls[index].b.x, rawPoint.y - state.walls[index].b.y) < 14 / state.zoom) handle = 'b';
    }
    if (!handle) {
      index = -1;
      for (let i = state.walls.length - 1; i >= 0; i -= 1) {
        if (floorItemVisible(state.walls[i]) && pointToSegmentDistance(rawPoint, state.walls[i].a, state.walls[i].b) < 18 / state.zoom) { index = i; break; }
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
      if (floorItemVisible(state.rulers[i]) && pointToSegmentDistance(raw, state.rulers[i].a, state.rulers[i].b) < 12 / state.zoom) { rulerIndex = i; break; }
    }
    if (rulerIndex >= 0) { commitRulers(state.rulers.filter((_, i) => i !== rulerIndex)); return; }
    const objectIndex = objectAtPoint(raw);
    if (objectIndex >= 0) { commitObjects(state.objects.filter((_, i) => i !== objectIndex)); return; }
    const shapeIndex = shapeAtPoint(raw);
    if (shapeIndex >= 0) { commitShapes(state.shapes.filter((_, i) => i !== shapeIndex)); return; }
    let index = -1;
    for (let i = state.walls.length - 1; i >= 0; i -= 1) {
      if (floorItemVisible(state.walls[i]) && pointToSegmentDistance(raw, state.walls[i].a, state.walls[i].b) < 18 / state.zoom) { index = i; break; }
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
  if (state.shapeDragMode && state.selectedShape !== null) { updateShapeDrag(event); renderWallList(); draw(); return; }
  if (state.objectDragMode && state.selectedObject !== null) { updateObjectDrag(event); renderWallList(); draw(); return; }
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
  if (state.shapeDragMode && state.selectedShape !== null) {
    if (JSON.stringify(state.shapes) !== JSON.stringify(state.shapeDragSnapshot.shapes)) { pushHistory(state.shapeDragSnapshot); markDirty(); persist(); }
    state.shapeDragMode = null; state.shapeDragSnapshot = null; state.shapeDragStart = null; state.shapeDragOriginal = null;
    updateUi(); draw(); setCanvasCursor(); return;
  }
  if (state.objectDragMode && state.selectedObject !== null) {
    if (JSON.stringify(state.objects) !== JSON.stringify(state.objectDragSnapshot.objects)) { pushHistory(state.objectDragSnapshot); markDirty(); persist(); }
    state.objectDragMode = null; state.objectDragSnapshot = null; state.objectDragStart = null; state.objectDragOriginal = null;
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
  state.shapeDragMode = null; state.shapeDragSnapshot = null; state.shapeDragStart = null; state.shapeDragOriginal = null;
  state.objectDragMode = null; state.objectDragSnapshot = null; state.objectDragStart = null; state.objectDragOriginal = null;
  if (tool !== 'edit') { state.selectedWall = null; clearFloorMultiSelection(); state.selectMode = 'single'; }
  if (tool !== 'shapes') state.selectedShape = null;
  if (tool !== 'objects') state.selectedObject = null;
  if (tool !== 'text') state.selectedLabel = null;
  if (tool !== 'ruler') state.selectedRuler = null;
  state.tool = tool;
  $('#shapePalette').hidden = tool !== 'shapes';
  $('#objectPalette').hidden = tool !== 'objects';
  syncSelectModeUi();
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  const content = {
    wall: ['Wall tool', 'Drag between grid points Ãƒâ€šÃ‚Â· Hold Shift for a straight wall'],
    edit: [state.selectMode === 'highlight' ? 'Highlight Select' : 'Select tool', state.selectMode === 'highlight' ? 'Drag a box around complete items; drag a highlighted item to move the group' : 'Select one wall, then drag either endpoint'],
    ruler: ['Ruler tool', 'Drag to measure; select and drag a line, endpoint, or label'],
    shapes: ['Shapes tool', 'Choose a shape, then drag on the canvas; selected shapes can be moved or resized'],
    objects: ['Objects tool', 'Choose a car or person; click to insert, then drag to move or resize'],
    text: ['Text tool', 'Click to add Ãƒâ€šÃ‚Â· Drag to move Ãƒâ€šÃ‚Â· Double-click to edit'],
    erase: ['Erase tool', 'Click a wall to remove it'], pan: ['Pan tool', 'Drag to move the grid and plan'],
  }[tool];
  $('#modeLabel').textContent = content[0]; $('#modeHelp').textContent = content[1]; setCanvasCursor(); updateUi(); draw();
}

function undo() {
  if (!state.history.length) return; state.future.push(documentSnapshot());
  restoreSnapshot(state.history.pop()); state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; state.selectedObject = null; clearFloorMultiSelection(); markDirty(); persist(); draw(); updateUi();
}
function redo() {
  if (!state.future.length) return; state.history.push(documentSnapshot());
  restoreSnapshot(state.future.pop()); state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; state.selectedObject = null; clearFloorMultiSelection(); markDirty(); persist(); draw(); updateUi();
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
  if (project.objects !== undefined && (!Array.isArray(project.objects) || !project.objects.every((object) =>
    object && Object.prototype.hasOwnProperty.call(OBJECT_DEFS, object.symbol) && validPoint(object) && Number(object.width) > 0 && Number(object.height) > 0))) throw new Error('This plan contains invalid objects.');
  if (project.layers !== undefined && (!Array.isArray(project.layers) || !project.layers.every((layer) => layer && (layer.id === undefined || typeof layer.id === 'string'))))
    throw new Error('This plan contains invalid layers.');
  state.layers = normalizeLayers(project.layers || []);
  const legacyThickness = Number(project.settings?.wallWidth);
  state.walls = project.walls.map((wall) => {
    const thickness = Number(wall.thickness);
    const fallback = Number.isFinite(legacyThickness) ? Math.max(3, Math.min(12, legacyThickness)) : 6;
    return { a: { x: Number(wall.a.x), y: Number(wall.a.y) }, b: { x: Number(wall.b.x), y: Number(wall.b.y) }, thickness: Number.isFinite(thickness) ? Math.max(3, Math.min(12, thickness)) : fallback, color: normalizeColor(wall.color, DEFAULT_WALL_COLOR), shade: normalizeShade(wall.shade), layerId: layerAssignmentId(wall.layerId) };
  });
  state.labels = (project.labels || []).map((label) => {
    const size = Number(label.fontSize);
    return { text: label.text.slice(0, 200), x: Number(label.x), y: Number(label.y), fontSize: Number.isFinite(size) ? Math.max(10, Math.min(48, Math.round(size))) : 16, layerId: layerAssignmentId(label.layerId) };
  });
  state.rulers = (project.rulers || []).map((ruler) => ({
    a: { x: Number(ruler.a.x), y: Number(ruler.a.y) }, b: { x: Number(ruler.b.x), y: Number(ruler.b.y) },
    ...(validPoint(ruler.labelOffset) ? { labelOffset: { x: Number(ruler.labelOffset.x), y: Number(ruler.labelOffset.y) } } : {}),
    layerId: layerAssignmentId(ruler.layerId),
  }));
  state.shapes = (project.shapes || []).map((shape) => {
    const style = { color: normalizeColor(shape.color, DEFAULT_SHAPE_COLOR), shade: normalizeShade(shape.shade), layerId: layerAssignmentId(shape.layerId) };
    if (shape.type === 'square' || shape.type === 'rectangle' || shape.type === 'line') return { type: shape.type, a: { x: Number(shape.a.x), y: Number(shape.a.y) }, b: { x: Number(shape.b.x), y: Number(shape.b.y) }, ...style };
    return { type: shape.type, center: { x: Number(shape.center.x), y: Number(shape.center.y) }, radius: Math.max(0, Number(shape.radius)), ...style };
  });
  state.objects = (project.objects || []).map((object) => ({ symbol: object.symbol, x: Number(object.x), y: Number(object.y), width: Math.max(1, Number(object.width)), height: Math.max(1, Number(object.height)), layerId: layerAssignmentId(object.layerId) }));
  if (typeof loadElevationProject === 'function') loadElevationProject(project.elevations);
  if ([1, 3, 6, 12, 24].includes(Number(project.settings?.gridInches))) state.gridInches = Number(project.settings.gridInches);
  if (Number(project.settings?.wallWidth) >= 3 && Number(project.settings?.wallWidth) <= 12) state.wallWidth = Number(project.settings.wallWidth);
  state.showText = project.settings?.showText !== false; state.showDimensions = project.settings?.showDimensions !== false;
  state.grid = gridPixels(state.gridInches);
  if (Number.isFinite(Number(project.viewport?.zoom))) state.zoom = Math.max(.1, Math.min(2, Number(project.viewport.zoom)));
  if (validPoint(project.viewport?.offset)) state.offset = { x: Number(project.viewport.offset.x), y: Number(project.viewport.offset.y) };
  const fromServer = Object.prototype.hasOwnProperty.call(options, 'serverId');
  state.serverId = fromServer ? options.serverId : null;
  state.serverName = fromServer ? (options.serverName || 'Untitled plan') : 'Untitled plan';
  state.dirty = false;
  state.history = []; state.future = []; state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; state.selectedObject = null; clearFloorMultiSelection();
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
    $('#saveStatus').textContent = saveAsNew ? 'Saving new planÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : 'Saving to serverÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦';
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
  const loading = document.createElement('p'); loading.className = 'dialog-message'; loading.textContent = 'Loading plansÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦'; list.append(loading);
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
  state.walls = []; state.labels = []; state.rulers = []; state.shapes = []; state.objects = []; state.layers = []; state.history = []; state.future = [];
  state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; state.selectedObject = null; state.editingHandle = null; state.draggingLabel = false;
  state.start = null; state.preview = null; state.zoom = 1; state.offset = { x: 0, y: 0 };
  state.gridInches = 12; state.grid = gridPixels(12); state.wallWidth = 6;
  state.showText = true; state.showDimensions = true;
  state.serverId = null; state.serverName = 'Untitled plan'; state.editingLayerId = null; state.deletingLayerId = null; state.dirty = false;
  if (typeof resetElevationProject === 'function') resetElevationProject(false);
  persist(); updateUi(); draw(); setTool('wall'); $('#saveStatus').textContent = 'New project';
}

function requestNewProject() {
  if (!state.dirty) { resetProject(); return; }
  $('#newProjectDialog').showModal();
}

document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-select-mode]').forEach((button) => button.addEventListener('click', () => {
  state.selectMode = button.dataset.selectMode; if (state.selectMode === 'single') clearFloorMultiSelection(); else clearFloorSingleSelection();
  document.querySelectorAll('[data-select-mode]').forEach((choice) => choice.classList.toggle('active', choice === button));
  setTool('edit'); updateUi(); draw();
}));
document.querySelectorAll('[data-shape]').forEach((button) => button.addEventListener('click', () => {
  state.shapeKind = button.dataset.shape;
  document.querySelectorAll('[data-shape]').forEach((choice) => choice.classList.toggle('active', choice === button));
  setTool('shapes');
}));
document.querySelectorAll('[data-object]').forEach((button) => button.addEventListener('click', () => {
  state.objectKind = button.dataset.object;
  document.querySelectorAll('[data-object]').forEach((choice) => choice.classList.toggle('active', choice === button));
  setTool('objects');
}));
$('#undoButton').addEventListener('click', undo); $('#redoButton').addEventListener('click', redo);
$('#centerButton').addEventListener('click', () => { if (state.offset.x || state.offset.y) markDirty(); state.offset = { x: 0, y: 0 }; persist(); draw(); });
$('#clearButton').addEventListener('click', () => {
  if ((!state.walls.length && !state.labels.length && !state.rulers.length && !state.shapes.length && !state.objects.length) || !confirm('Clear the entire floor plan?')) return;
  pushHistory(); state.walls = []; state.labels = []; state.rulers = []; state.shapes = []; state.objects = []; state.selectedWall = null; state.selectedLabel = null; state.selectedRuler = null; state.selectedShape = null; state.selectedObject = null; markDirty(); persist(); updateUi(); draw();
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
$('#layerSelect').addEventListener('change', (event) => { if (event.target.value !== '__mixed__') applyLayerToSelection(event.target.value); });
$('#addLayerButton').addEventListener('click', createLayer);
$('#layerColor').addEventListener('input', (event) => { $('#layerColorValue').textContent = normalizeColor(event.target.value, DEFAULT_LAYER_COLOR); });
$('#layerOpacity').addEventListener('input', (event) => { $('#layerOpacityValue').textContent = `${event.target.value}%`; });
$('#saveLayerEdit').addEventListener('click', saveLayerDialog);
$('#cancelLayerEdit').addEventListener('click', closeLayerDialog);
$('#closeLayerDialog').addEventListener('click', closeLayerDialog);
$('#layerDialog').addEventListener('click', (event) => { if (event.target === $('#layerDialog')) closeLayerDialog(); });
$('#confirmDeleteLayer').addEventListener('click', confirmDeleteLayer);
$('#cancelDeleteLayer').addEventListener('click', closeDeleteLayerDialog);
$('#closeDeleteLayerDialog').addEventListener('click', closeDeleteLayerDialog);
$('#deleteLayerDialog').addEventListener('click', (event) => { if (event.target === $('#deleteLayerDialog')) closeDeleteLayerDialog(); });
$('#gridSize').addEventListener('change', (event) => {
  const oldGrid = state.grid; state.gridInches = Number(event.target.value); state.grid = gridPixels(state.gridInches);
  const scale = state.grid / oldGrid;
  state.walls = state.walls.map((wall) => ({ ...wall, a: { x: wall.a.x * scale, y: wall.a.y * scale }, b: { x: wall.b.x * scale, y: wall.b.y * scale } }));
  state.labels = state.labels.map((label) => ({ ...label, x: label.x * scale, y: label.y * scale }));
  state.rulers = state.rulers.map((ruler) => ({ ...ruler, a: { x: ruler.a.x * scale, y: ruler.a.y * scale }, b: { x: ruler.b.x * scale, y: ruler.b.y * scale }, ...(ruler.labelOffset ? { labelOffset: { x: ruler.labelOffset.x * scale, y: ruler.labelOffset.y * scale } } : {}) }));
  state.shapes = state.shapes.map((shape) => shape.a ? { ...shape, a: { x: shape.a.x * scale, y: shape.a.y * scale }, b: { x: shape.b.x * scale, y: shape.b.y * scale } } : { ...shape, center: { x: shape.center.x * scale, y: shape.center.y * scale }, radius: shape.radius * scale });
  state.objects = state.objects.map((object) => ({ ...object, x: object.x * scale, y: object.y * scale, width: object.width * scale, height: object.height * scale }));
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
  const elevationActive = $('#elevationWorkspace') && !$('#elevationWorkspace').hidden;
  const targetCanvas = elevationActive ? $('#elevationCanvas') : canvas;
  const link = document.createElement('a'); link.download = elevationActive ? 'gridline-elevation.png' : 'gridline-floor-plan.png'; link.href = targetCanvas.toDataURL('image/png'); link.click();
});
window.addEventListener('keydown', (event) => {
  if (typeof elevationPageActive === 'function' && elevationPageActive()) return;
  if (event.code === 'Space' && !event.repeat) { state.spacePressed = true; setCanvasCursor(); event.preventDefault(); }
  if (event.key.toLowerCase() === 'w') setTool('wall'); if (event.key.toLowerCase() === 'v') setTool('edit'); if (event.key.toLowerCase() === 'r') setTool('ruler'); if (event.key.toLowerCase() === 's') setTool('shapes'); if (event.key.toLowerCase() === 'o') setTool('objects'); if (event.key.toLowerCase() === 't') setTool('text'); if (event.key.toLowerCase() === 'e') setTool('erase'); if (event.key.toLowerCase() === 'p') setTool('pan');
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
function handleFloorHighlightPointerDown(event) {
  if (elevationPageActive() || state.tool !== 'edit' || state.selectMode !== 'highlight' || event.button !== 0 || state.spacePressed) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const point = canvasPoint(event);
  if (hasFloorMultiSelection() && floorSelectedItemAtEvent(event)) { state.multiDragSnapshot = documentSnapshot(); state.multiDragStart = point; state.multiDragSelection = structuredClone(state.multiSelected); canvas.setPointerCapture(event.pointerId); setCanvasCursor(); draw(); return; }
  clearFloorSingleSelection(); state.boxSelecting = true; state.boxStart = rawCanvasPoint(event); state.boxCurrent = state.boxStart; canvas.setPointerCapture(event.pointerId); setCanvasCursor(); updateUi(); draw();
}
function handleFloorHighlightPointerMove(event) {
  if (elevationPageActive()) return;
  if (state.boxSelecting) { event.preventDefault(); event.stopImmediatePropagation(); state.boxCurrent = rawCanvasPoint(event); draw(); return; }
  if (state.multiDragSnapshot && state.multiDragSelection) { event.preventDefault(); event.stopImmediatePropagation(); const point = canvasPoint(event), dx = point.x - state.multiDragStart.x, dy = point.y - state.multiDragStart.y; restoreSnapshot(state.multiDragSnapshot); moveFloorSelectionBy(state.multiDragSelection, dx, dy); renderWallList(); draw(); }
}
function handleFloorHighlightPointerEnd(event) {
  if (elevationPageActive()) return;
  if (state.boxSelecting) { event.preventDefault(); event.stopImmediatePropagation(); state.multiSelected = selectFloorItemsInRect(state.boxStart, state.boxCurrent || state.boxStart); state.boxSelecting = false; state.boxStart = null; state.boxCurrent = null; updateUi(); draw(); setCanvasCursor(); return; }
  if (state.multiDragSnapshot && state.multiDragSelection) { event.preventDefault(); event.stopImmediatePropagation(); if (JSON.stringify(documentSnapshot()) !== JSON.stringify(state.multiDragSnapshot)) { pushHistory(state.multiDragSnapshot); markDirty(); persist(); } state.multiDragSnapshot = null; state.multiDragStart = null; state.multiDragSelection = null; updateUi(); draw(); setCanvasCursor(); }
}
canvas.addEventListener('pointerdown', handleFloorHighlightPointerDown, true);
canvas.addEventListener('pointermove', handleFloorHighlightPointerMove, true);
canvas.addEventListener('pointerup', handleFloorHighlightPointerEnd, true);
canvas.addEventListener('pointercancel', handleFloorHighlightPointerEnd, true);
window.addEventListener('keydown', (event) => {
  if (elevationPageActive() || isTypingTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'c') { if (copyFloorSelection()) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
  if ((event.ctrlKey || event.metaKey) && key === 'v') { if (pasteFloorClipboard()) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
  if ((event.key === 'Delete' || event.key === 'Backspace') && deleteFloorSelection()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);new ResizeObserver(resize).observe(shell);
updateUi(); resize(); setTool('wall'); persist();

// Elevation workspace: a compact second drafting page for front/side/rear house elevations.
const elevationCanvas = $('#elevationCanvas');
const elevationShell = elevationCanvas?.parentElement;
const elevationCtx = elevationCanvas?.getContext('2d');
const ELEVATION_VIEW_KEYS = ['front', 'right', 'left', 'rear'];
const ELEVATION_VIEW_NAMES = { front: 'Front', right: 'Right side', left: 'Left side', rear: 'Rear' };
const ELEVATION_DEFAULT_COLOR = '#242620';

function blankElevationView() { return { items: [], zoom: 1, offset: { x: 70, y: 360 }, gridInches: 12 }; }
function normalizeElevationView(view = {}) {
  const clean = blankElevationView();
  clean.zoom = Number.isFinite(Number(view.zoom)) ? Math.max(.1, Math.min(2, Number(view.zoom))) : clean.zoom;
  if (validPoint(view.offset)) clean.offset = { x: Number(view.offset.x), y: Number(view.offset.y) };
  if ([1, 3, 6, 12, 24].includes(Number(view.gridInches))) clean.gridInches = Number(view.gridInches);
  clean.items = Array.isArray(view.items) ? view.items.filter((item) => item && ['line', 'rect', 'dimension', 'text'].includes(item.type)).map((item) => {
    const base = { type: item.type, color: normalizeColor(item.color, ELEVATION_DEFAULT_COLOR), width: Math.max(1, Math.min(8, Number(item.width) || 2)) };
    if (item.type === 'text') return { ...base, text: String(item.text || '').slice(0, 200), x: Number(item.x) || 0, y: Number(item.y) || 0, fontSize: Math.max(10, Math.min(48, Number(item.fontSize) || 14)) };
    return validPoint(item.a) && validPoint(item.b) ? { ...base, a: { x: Number(item.a.x), y: Number(item.a.y) }, b: { x: Number(item.b.x), y: Number(item.b.y) }, ...(item.type === 'dimension' && validPoint(item.labelOffset) ? { labelOffset: { x: Number(item.labelOffset.x), y: Number(item.labelOffset.y) } } : {}) } : null;
  }).filter(Boolean) : [];
  return clean;
}
function normalizeElevationProject(data) {
  const sourceViews = data?.views || data || {};
  return {
    currentView: ELEVATION_VIEW_KEYS.includes(data?.currentView) ? data.currentView : 'front',
    views: Object.fromEntries(ELEVATION_VIEW_KEYS.map((key) => [key, normalizeElevationView(sourceViews[key])])),
  };
}

const elevationInitial = normalizeElevationProject(saved.elevations);
const elevationState = {
  currentView: elevationInitial.currentView,
  views: elevationInitial.views,
  tool: 'line', color: ELEVATION_DEFAULT_COLOR, lineWidth: 2, textSize: 14,
  history: [], future: [], styleSnapshot: null, selectMode: 'single', selection: [], boxSelecting: false, boxStart: null, boxCurrent: null,
  multiDragSnapshot: null, multiDragStart: null, multiDragSelection: null, clipboard: null,
  selected: null, drawing: null, dragging: null, dragSnapshot: null, dragStart: null, dragOriginal: null,
  panning: false, panPointer: null, spacePressed: false, dpr: window.devicePixelRatio || 1,
};

function currentElevation() { return elevationState.views[elevationState.currentView]; }
function elevationGridPixels() { return gridPixels(currentElevation().gridInches); }
function elevationPixelsToInches(pixels) { return pixels / elevationGridPixels() * currentElevation().gridInches; }
function elevationFeetToPixels(feet) { return feet * 12 / currentElevation().gridInches * elevationGridPixels(); }
function elevationSegmentLengthInches(item) { return elevationPixelsToInches(Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y)); }
function setElevationSegmentLength(item, feet) {
  const dx = item.b.x - item.a.x, dy = item.b.y - item.a.y, current = Math.hypot(dx, dy) || 1;
  const length = elevationFeetToPixels(feet);
  item.b = { x: item.a.x + dx / current * length, y: item.a.y + dy / current * length };
}
function selectedElevationLengthInfo() {
  const item = currentElevation().items[elevationState.selected];
  if (!item || !['line', 'dimension'].includes(item.type)) return null;
  return { label: item.type === 'dimension' ? 'Selected dimension length (ft)' : 'Selected line length (ft)', length: feetValueFromInches(elevationSegmentLengthInches(item)) };
}
function elevationSnapshot() { return structuredClone(elevationState.views); }
function restoreElevationSnapshot(snapshot) { elevationState.views = structuredClone(snapshot); }
function pushElevationHistory(snapshot = elevationSnapshot()) {
  elevationState.history.push(structuredClone(snapshot));
  if (elevationState.history.length > 100) elevationState.history.shift();
  elevationState.future = [];
}
function undoElevation() {
  if (!elevationState.history.length) return;
  elevationState.future.push(elevationSnapshot());
  restoreElevationSnapshot(elevationState.history.pop());
  elevationState.selected = null; elevationState.drawing = null; elevationState.dragging = null; elevationState.styleSnapshot = null;
  markDirty(); persist(); updateElevationUi(); drawElevation();
}
function redoElevation() {
  if (!elevationState.future.length) return;
  elevationState.history.push(elevationSnapshot());
  restoreElevationSnapshot(elevationState.future.pop());
  elevationState.selected = null; elevationState.drawing = null; elevationState.dragging = null; elevationState.styleSnapshot = null;
  markDirty(); persist(); updateElevationUi(); drawElevation();
}
function applyElevationSelectedLength(feet) {
  const value = Number(feet), item = currentElevation().items[elevationState.selected];
  if (!item || !['line', 'dimension'].includes(item.type) || !Number.isFinite(value) || value <= 0) return;
  const snapshot = elevationSnapshot();
  setElevationSegmentLength(item, value);
  if (JSON.stringify(elevationState.views) !== JSON.stringify(snapshot)) pushElevationHistory(snapshot);
  markDirty(); persist(); updateElevationUi(); drawElevation();
}
function elevationProjectData() { return { version: 1, currentView: elevationState.currentView, views: structuredClone(elevationState.views) }; }
function loadElevationProject(data) {
  const next = normalizeElevationProject(data);
  elevationState.currentView = next.currentView; elevationState.views = next.views; elevationState.selected = null; elevationState.history = []; elevationState.future = []; elevationState.styleSnapshot = null;
  updateElevationUi(); resizeElevation(); drawElevation();
}
function resetElevationProject(redraw = true) {
  const next = normalizeElevationProject(null);
  elevationState.currentView = 'front'; elevationState.views = next.views; elevationState.selected = null; elevationState.history = []; elevationState.future = []; elevationState.styleSnapshot = null;
  if (redraw) { updateElevationUi(); resizeElevation(); drawElevation(); }
}

function elevationScreenPoint(event) { const rect = elevationCanvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
function elevationRawPoint(event) { const point = elevationScreenPoint(event), view = currentElevation(); return { x: (point.x - view.offset.x) / view.zoom, y: (point.y - view.offset.y) / view.zoom }; }
function elevationSnapPoint(event) { const raw = elevationRawPoint(event), grid = elevationGridPixels(); return { x: Math.round(raw.x / grid) * grid, y: Math.round(raw.y / grid) * grid }; }
function elevationToScreen(point) { const view = currentElevation(); return { x: view.offset.x + point.x * view.zoom, y: view.offset.y + point.y * view.zoom }; }

function resizeElevation() {
  if (!elevationCanvas || !elevationShell) return;
  const { width, height } = elevationShell.getBoundingClientRect();
  elevationCanvas.width = Math.floor(width * elevationState.dpr); elevationCanvas.height = Math.floor(height * elevationState.dpr);
  elevationCanvas.style.width = `${width}px`; elevationCanvas.style.height = `${height}px`; drawElevation();
}
function drawElevationGrid(width, height) {
  const view = currentElevation(), spacing = elevationGridPixels() * view.zoom;
  const startX = ((view.offset.x % spacing) + spacing) % spacing, startY = ((view.offset.y % spacing) + spacing) % spacing;
  elevationCtx.lineWidth = 1;
  for (let x = startX; x <= width; x += spacing) { const index = Math.round((x - view.offset.x) / spacing); elevationCtx.strokeStyle = index % 5 === 0 ? '#c7c3b8' : '#d8d4ca'; elevationCtx.beginPath(); elevationCtx.moveTo(x, 0); elevationCtx.lineTo(x, height); elevationCtx.stroke(); }
  for (let y = startY; y <= height; y += spacing) { const index = Math.round((y - view.offset.y) / spacing); elevationCtx.strokeStyle = index % 5 === 0 ? '#c7c3b8' : '#d8d4ca'; elevationCtx.beginPath(); elevationCtx.moveTo(0, y); elevationCtx.lineTo(width, y); elevationCtx.stroke(); }
}
function elevationDimensionLabelPosition(item) {
  const view = currentElevation(), midpoint = { x: (item.a.x + item.b.x) / 2, y: (item.a.y + item.b.y) / 2 };
  if (validPoint(item.labelOffset)) return { x: midpoint.x + item.labelOffset.x, y: midpoint.y + item.labelOffset.y };
  const dx = item.b.x - item.a.x, dy = item.b.y - item.a.y, length = Math.hypot(dx, dy) || 1;
  return { x: midpoint.x - dy / length * (15 / view.zoom), y: midpoint.y + dx / length * (15 / view.zoom) };
}
function drawElevationPreviewLength(item) {
  const a = elevationToScreen(item.a), b = elevationToScreen(item.b), dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
  const x = (a.x + b.x) / 2 - dy / length * 14, y = (a.y + b.y) / 2 + dx / length * 14;
  const label = formatLength(elevationPixelsToInches(Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y)));
  elevationCtx.save(); elevationCtx.font = '600 11px "DM Sans", sans-serif'; elevationCtx.textAlign = 'center'; elevationCtx.textBaseline = 'middle';
  const width = elevationCtx.measureText(label).width + 12; elevationCtx.fillStyle = 'rgba(247,244,236,.92)'; elevationCtx.fillRect(x - width / 2, y - 10, width, 20);
  elevationCtx.fillStyle = '#a34329'; elevationCtx.fillText(label, x, y + .5); elevationCtx.restore();
}
function drawElevationItem(item, preview = false, selected = false) {
  const view = currentElevation(); elevationCtx.save(); elevationCtx.translate(view.offset.x, view.offset.y); elevationCtx.scale(view.zoom, view.zoom);
  elevationCtx.strokeStyle = preview || selected ? '#b54b2d' : normalizeColor(item.color, ELEVATION_DEFAULT_COLOR); elevationCtx.fillStyle = elevationCtx.strokeStyle;
  elevationCtx.lineWidth = Math.max(1, Number(item.width) || 2) / view.zoom; elevationCtx.lineCap = 'round'; elevationCtx.lineJoin = 'round';
  if (item.type === 'line' || item.type === 'dimension') { elevationCtx.setLineDash(item.type === 'dimension' ? [8 / view.zoom, 5 / view.zoom] : []); elevationCtx.beginPath(); elevationCtx.moveTo(item.a.x, item.a.y); elevationCtx.lineTo(item.b.x, item.b.y); elevationCtx.stroke(); elevationCtx.setLineDash([]); if (item.type === 'dimension') { const dx = item.b.x - item.a.x, dy = item.b.y - item.a.y, length = Math.hypot(dx, dy) || 1, nx = -dy / length, ny = dx / length, cap = 6 / view.zoom; [[item.a.x, item.a.y], [item.b.x, item.b.y]].forEach(([x, y]) => { elevationCtx.beginPath(); elevationCtx.moveTo(x - nx * cap, y - ny * cap); elevationCtx.lineTo(x + nx * cap, y + ny * cap); elevationCtx.stroke(); }); } }
  if (item.type === 'rect') { const x = Math.min(item.a.x, item.b.x), y = Math.min(item.a.y, item.b.y); elevationCtx.strokeRect(x, y, Math.abs(item.b.x - item.a.x), Math.abs(item.b.y - item.a.y)); }
  if (item.type === 'text') { elevationCtx.font = `600 ${item.fontSize || 14}px "DM Sans", sans-serif`; elevationCtx.textAlign = 'center'; elevationCtx.textBaseline = 'middle'; elevationCtx.fillText(item.text, item.x, item.y); }
  if (item.type === 'dimension') {
    const label = formatLength(elevationPixelsToInches(Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y)));
    const mid = elevationDimensionLabelPosition(item);
    elevationCtx.font = `600 ${12 / view.zoom}px "DM Sans", sans-serif`; elevationCtx.textAlign = 'center'; elevationCtx.textBaseline = 'middle'; elevationCtx.fillText(label, mid.x, mid.y);
  }
  if (selected && item.type !== 'text') { elevationCtx.strokeStyle = '#b54b2d'; elevationCtx.setLineDash([6 / view.zoom, 4 / view.zoom]); if (item.type === 'rect') { const x = Math.min(item.a.x, item.b.x), y = Math.min(item.a.y, item.b.y); elevationCtx.strokeRect(x, y, Math.abs(item.b.x - item.a.x), Math.abs(item.b.y - item.a.y)); } else { elevationCtx.beginPath(); elevationCtx.moveTo(item.a.x, item.a.y); elevationCtx.lineTo(item.b.x, item.b.y); elevationCtx.stroke(); } }
  elevationCtx.restore();
  if (preview && item.type === 'line') drawElevationPreviewLength(item);
  if (selected) drawElevationHandles(item);
}
function drawElevationHandle(point) { const screen = elevationToScreen(point); elevationCtx.save(); elevationCtx.beginPath(); elevationCtx.arc(screen.x, screen.y, 6, 0, Math.PI * 2); elevationCtx.fillStyle = '#fffdf8'; elevationCtx.fill(); elevationCtx.lineWidth = 2; elevationCtx.strokeStyle = '#b54b2d'; elevationCtx.stroke(); elevationCtx.restore(); }
function drawElevationHandles(item) { if (item.type === 'text') drawElevationHandle({ x: item.x, y: item.y }); else { drawElevationHandle(item.a); drawElevationHandle(item.b); } }
function drawElevation() {
  if (!elevationCanvas || !elevationCtx) return;
  const width = elevationCanvas.width / elevationState.dpr, height = elevationCanvas.height / elevationState.dpr;
  elevationCtx.setTransform(elevationState.dpr, 0, 0, elevationState.dpr, 0, 0); elevationCtx.clearRect(0, 0, width, height); elevationCtx.fillStyle = '#f1eee6'; elevationCtx.fillRect(0, 0, width, height); drawElevationGrid(width, height);
  const view = currentElevation(); elevationCtx.save(); elevationCtx.translate(view.offset.x, view.offset.y); elevationCtx.scale(view.zoom, view.zoom); elevationCtx.strokeStyle = '#9c988f'; elevationCtx.lineWidth = 2 / view.zoom; elevationCtx.beginPath(); elevationCtx.moveTo(-10000, 0); elevationCtx.lineTo(10000, 0); elevationCtx.stroke(); elevationCtx.restore();
  view.items.forEach((item, index) => drawElevationItem(item, false, elevationState.selected === index || elevationSelectionIncludes(index)));
  if (elevationState.drawing?.item) drawElevationItem(elevationState.drawing.item, true, false);
  drawElevationSelectionBox();
}

function elevationItemName(item) { return item.type === 'dimension' ? 'Dimension' : item.type === 'rect' ? 'Rectangle' : item.type === 'text' ? 'Text' : 'Line'; }
function elevationItemDetail(item) { if (item.type === 'text') return item.text; if (item.type === 'rect') return `${formatLength(elevationPixelsToInches(Math.abs(item.b.x - item.a.x)))} ÃƒÆ’Ã¢â‚¬â€ ${formatLength(elevationPixelsToInches(Math.abs(item.b.y - item.a.y)))}`; return formatLength(elevationPixelsToInches(Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y))); }
function renderElevationList() {
  const list = $('#elevationList'); if (!list) return; list.replaceChildren(); const items = currentElevation().items;
  if (!items.length) { const empty = document.createElement('li'); empty.className = 'empty-list'; empty.textContent = 'Draw elevation lines, dimensions, rectangles, or labels.'; list.append(empty); }
  else items.forEach((item, index) => { const li = document.createElement('li'), name = document.createElement('span'), detail = document.createElement('strong'); name.textContent = `${elevationItemName(item)} ${index + 1}`; detail.textContent = elevationItemDetail(item); li.append(name, detail); li.addEventListener('click', () => { setElevationTool('select'); elevationState.selected = index; updateElevationUi(); drawElevation(); }); list.append(li); });
  $('#elevItemCount').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
}
function updateElevationUi() {
  if (!elevationCanvas) return;
  $('#elevationViewSelect').value = elevationState.currentView; $('#elevGridSize').value = String(currentElevation().gridInches); $('#elevZoomLabel').textContent = `${Math.round(currentElevation().zoom * 100)}%`;
  $('#elevColor').value = elevationState.color; $('#elevColorValue').textContent = elevationState.color; $('#elevLineWidth').value = String(elevationState.lineWidth); $('#elevLineWidthValue').textContent = `${elevationState.lineWidth} px`; $('#elevTextSize').value = String(elevationState.textSize); $('#elevTextSizeValue').textContent = `${elevationState.textSize} px`;
  const selected = currentElevation().items[elevationState.selected];
  if (selected) { if (selected.color) { $('#elevColor').value = normalizeColor(selected.color, ELEVATION_DEFAULT_COLOR); $('#elevColorValue').textContent = $('#elevColor').value; } if (selected.width) { $('#elevLineWidth').value = String(selected.width); $('#elevLineWidthValue').textContent = `${selected.width} px`; } if (selected.fontSize) { $('#elevTextSize').value = String(selected.fontSize); $('#elevTextSizeValue').textContent = `${selected.fontSize} px`; } }
  const lengthInfo = selectedElevationLengthInfo(), lengthInput = $('#elevLength'), lengthLabel = $('#elevLengthLabel');
  if (lengthInput) { lengthInput.disabled = !lengthInfo; lengthInput.value = lengthInfo?.length || ''; }
  if (lengthLabel) lengthLabel.textContent = lengthInfo?.label || 'Selected line length (ft)';
  const undoButton = $('#elevUndoButton'), redoButton = $('#elevRedoButton');
  if (undoButton) undoButton.disabled = !elevationState.history.length;
  if (redoButton) redoButton.disabled = !elevationState.future.length;
  renderElevationList();
}
function setElevationTool(tool) {
  elevationState.tool = tool; elevationState.drawing = null; elevationState.dragging = null;
  if (tool !== 'select') { elevationState.selected = null; clearElevationMultiSelection(); elevationState.selectMode = 'single'; }
  document.querySelectorAll('[data-elev-tool]').forEach((button) => button.classList.toggle('active', button.dataset.elevTool === tool));
  syncElevationSelectModeUi();
  const help = { line: ['Line tool', 'Drag to draw walls, roof lines, trim, and elevation outlines'], rect: ['Rectangle tool', 'Drag to draw windows, doors, garage doors, and wall blocks'], dimension: ['Dimension tool', 'Drag between two points to add a measurement'], text: ['Text tool', 'Click to add a label'], select: [elevationState.selectMode === 'highlight' ? 'Highlight Select' : 'Select tool', elevationState.selectMode === 'highlight' ? 'Drag a box around complete items; drag a highlighted item to move the group' : 'Drag items to move; drag line endpoints or rectangle corners to edit'], erase: ['Erase tool', 'Click an elevation item to remove it'], pan: ['Pan tool', 'Drag to move the elevation sheet'] }[tool];
  $('#elevModeLabel').textContent = help[0]; $('#elevModeHelp').textContent = help[1]; elevationCanvas.style.cursor = tool === 'pan' ? 'grab' : tool === 'select' ? 'pointer' : 'crosshair'; updateElevationUi(); drawElevation();
}

function elevationPointDistance(point, a, b) { return pointToSegmentDistance(point, a, b); }
function elevationTextHit(item, point) { elevationCtx.save(); elevationCtx.font = `600 ${item.fontSize || 14}px "DM Sans", sans-serif`; const width = elevationCtx.measureText(item.text).width; elevationCtx.restore(); return Math.abs(point.x - item.x) <= width / 2 + 8 && Math.abs(point.y - item.y) <= (item.fontSize || 14) / 2 + 8; }
function elevationItemPart(index, event) {
  const item = currentElevation().items[index], point = elevationRawPoint(event), tol = 12 / currentElevation().zoom;
  if (!item) return null; if (item.type === 'text') return elevationTextHit(item, point) ? 'body' : null;
  if (Math.hypot(point.x - item.a.x, point.y - item.a.y) <= tol) return 'a'; if (Math.hypot(point.x - item.b.x, point.y - item.b.y) <= tol) return 'b';
  if (item.type === 'dimension') {
    const screen = elevationScreenPoint(event), labelPosition = elevationToScreen(elevationDimensionLabelPosition(item));
    elevationCtx.save(); elevationCtx.font = '600 12px "DM Sans", sans-serif'; const labelWidth = elevationCtx.measureText(formatLength(elevationPixelsToInches(Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y)))).width + 12; elevationCtx.restore();
    if (Math.abs(screen.x - labelPosition.x) <= labelWidth / 2 && Math.abs(screen.y - labelPosition.y) <= 12) return 'label';
  }
  if (item.type === 'rect') { const x1 = Math.min(item.a.x, item.b.x), x2 = Math.max(item.a.x, item.b.x), y1 = Math.min(item.a.y, item.b.y), y2 = Math.max(item.a.y, item.b.y); return point.x >= x1 - tol && point.x <= x2 + tol && point.y >= y1 - tol && point.y <= y2 + tol ? 'body' : null; }
  return elevationPointDistance(point, item.a, item.b) <= tol ? 'body' : null;
}
function elevationItemAt(event) { for (let i = currentElevation().items.length - 1; i >= 0; i -= 1) { const part = elevationItemPart(i, event); if (part) return { index: i, part }; } return null; }
function moveElevationItem(item, dx, dy) { if (item.type === 'text') { item.x += dx; item.y += dy; } else { item.a = { x: item.a.x + dx, y: item.a.y + dy }; item.b = { x: item.b.x + dx, y: item.b.y + dy }; } }

function elevationSelectionIncludes(index) { return elevationState.selection.includes(index); }
function clearElevationMultiSelection() { elevationState.selection = []; }
function hasElevationMultiSelection() { return elevationState.selection.length > 0; }
function elevationItemBounds(item) {
  if (item.type === 'text') { elevationCtx.save(); elevationCtx.font = `600 ${item.fontSize || 14}px "DM Sans", sans-serif`; const width = elevationCtx.measureText(item.text).width; elevationCtx.restore(); const height = (item.fontSize || 14) * 1.35; return { x1: item.x - width / 2 - 7, y1: item.y - height / 2 - 4, x2: item.x + width / 2 + 7, y2: item.y + height / 2 + 4 }; }
  return boundsFromPoints([item.a, item.b]);
}
function selectElevationItemsInRect(a, b) { const rect = normalizedRect(a, b); return currentElevation().items.map((item, index) => rectContainsBounds(rect, elevationItemBounds(item)) ? index : null).filter((index) => index !== null); }
function drawElevationSelectionBox() { if (!elevationState.boxSelecting || !elevationState.boxStart || !elevationState.boxCurrent) return; const a = elevationToScreen(elevationState.boxStart), b = elevationToScreen(elevationState.boxCurrent), rect = normalizedRect(a, b); elevationCtx.save(); elevationCtx.fillStyle = 'rgba(181,75,45,.12)'; elevationCtx.strokeStyle = '#b54b2d'; elevationCtx.lineWidth = 1.5; elevationCtx.setLineDash([6, 4]); elevationCtx.fillRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1); elevationCtx.strokeRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1); elevationCtx.restore(); }
function elevationSelectedItemAtEvent(event) { const hit = elevationItemAt(event); return hit && elevationState.selection.includes(hit.index); }
function moveElevationSelectionBy(selection, dx, dy) { const items = currentElevation().items; selection.forEach((index) => { if (items[index]) moveElevationItem(items[index], dx, dy); }); }
function offsetElevationItem(item, offset) { const clone = structuredClone(item); if (clone.type === 'text') { clone.x += offset; clone.y += offset; } else { clone.a = { x: clone.a.x + offset, y: clone.a.y + offset }; clone.b = { x: clone.b.x + offset, y: clone.b.y + offset }; } return clone; }
function copyElevationSelection() { const indices = hasElevationMultiSelection() ? elevationState.selection : elevationState.selected !== null ? [elevationState.selected] : []; if (!indices.length) return false; const items = currentElevation().items; elevationState.clipboard = indices.filter((index) => items[index]).map((index) => structuredClone(items[index])); return elevationState.clipboard.length > 0; }
function pasteElevationClipboard() { if (!elevationState.clipboard?.length) return false; const snapshot = elevationSnapshot(), items = currentElevation().items, offset = elevationGridPixels() * 2, selection = []; elevationState.clipboard.forEach((item) => { selection.push(items.push(offsetElevationItem(item, offset)) - 1); }); pushElevationHistory(snapshot); markDirty(); persist(); setElevationTool('select'); elevationState.selectMode = 'highlight'; elevationState.selected = null; elevationState.selection = selection; syncElevationSelectModeUi(); updateElevationUi(); drawElevation(); return true; }
function deleteElevationSelection() { const items = currentElevation().items, indices = hasElevationMultiSelection() ? elevationState.selection : elevationState.selected !== null ? [elevationState.selected] : []; if (!indices.length) return false; const snapshot = elevationSnapshot(), omit = new Set(indices); currentElevation().items = items.filter((_, index) => !omit.has(index)); elevationState.selected = null; clearElevationMultiSelection(); pushElevationHistory(snapshot); markDirty(); persist(); updateElevationUi(); drawElevation(); return true; }
function syncElevationSelectModeUi() { const palette = $('#elevSelectPalette'); if (palette) palette.hidden = elevationState.tool !== 'select'; document.querySelectorAll('[data-elev-select-mode]').forEach((button) => button.classList.toggle('active', button.dataset.elevSelectMode === elevationState.selectMode)); }
function beginElevationPan(event) { elevationState.panning = true; elevationState.panPointer = elevationScreenPoint(event); elevationCanvas.setPointerCapture(event.pointerId); elevationCanvas.style.cursor = 'grabbing'; }
elevationCanvas?.addEventListener('pointerdown', (event) => {
  if (event.button === 1 || elevationState.tool === 'pan' || elevationState.spacePressed) { event.preventDefault(); beginElevationPan(event); return; }
  if (event.button !== 0) return; const point = elevationSnapPoint(event), view = currentElevation();
  if (elevationState.tool === 'text') { const text = prompt('Enter elevation label:'); if (text && text.trim()) { pushElevationHistory(); view.items.push({ type: 'text', text: text.trim().slice(0, 200), x: point.x, y: point.y, color: elevationState.color, fontSize: elevationState.textSize }); elevationState.selected = view.items.length - 1; markDirty(); persist(); updateElevationUi(); drawElevation(); } return; }
  if (elevationState.tool === 'select') { const hit = elevationItemAt(event); elevationState.selected = hit?.index ?? null; if (hit) { elevationState.dragging = hit.part; elevationState.dragSnapshot = elevationSnapshot(); elevationState.dragStart = hit.part === 'label' ? elevationRawPoint(event) : point; elevationState.dragOriginal = structuredClone(view.items[hit.index]); elevationCanvas.setPointerCapture(event.pointerId); elevationCanvas.style.cursor = 'grabbing'; } updateElevationUi(); drawElevation(); return; }
  if (elevationState.tool === 'erase') { const hit = elevationItemAt(event); if (hit) { pushElevationHistory(); view.items.splice(hit.index, 1); elevationState.selected = null; markDirty(); persist(); updateElevationUi(); drawElevation(); } return; }
  const type = elevationState.tool === 'rect' ? 'rect' : elevationState.tool === 'dimension' ? 'dimension' : 'line';
  elevationState.drawing = { type, start: point, item: { type, a: point, b: point, color: elevationState.color, width: elevationState.lineWidth } }; elevationCanvas.setPointerCapture(event.pointerId);
});
elevationCanvas?.addEventListener('pointermove', (event) => {
  const view = currentElevation();
  if (elevationState.panning) { const point = elevationScreenPoint(event); view.offset.x += point.x - elevationState.panPointer.x; view.offset.y += point.y - elevationState.panPointer.y; elevationState.panPointer = point; drawElevation(); return; }
  if (elevationState.dragging && elevationState.selected !== null) { const point = elevationSnapPoint(event), item = view.items[elevationState.selected]; Object.assign(item, structuredClone(elevationState.dragOriginal)); if (elevationState.dragging === 'body') moveElevationItem(item, point.x - elevationState.dragStart.x, point.y - elevationState.dragStart.y); else if (elevationState.dragging === 'label' && item.type === 'dimension') { const raw = elevationRawPoint(event), midpoint = { x: (item.a.x + item.b.x) / 2, y: (item.a.y + item.b.y) / 2 }; item.labelOffset = { x: raw.x - midpoint.x, y: raw.y - midpoint.y }; } else item[elevationState.dragging] = point; renderElevationList(); drawElevation(); return; }
  if (!elevationState.drawing) return; let point = elevationSnapPoint(event); if (event.shiftKey && elevationState.drawing.type !== 'rect') { const start = elevationState.drawing.start, dx = Math.abs(point.x - start.x), dy = Math.abs(point.y - start.y); point = dx > dy ? { x: point.x, y: start.y } : { x: start.x, y: point.y }; } elevationState.drawing.item = { ...elevationState.drawing.item, b: point }; drawElevation();
});
function endElevationPointer() {
  const view = currentElevation();
  if (elevationState.panning) { elevationState.panning = false; elevationState.panPointer = null; markDirty(); persist(); elevationCanvas.style.cursor = elevationState.tool === 'pan' ? 'grab' : 'crosshair'; return; }
  if (elevationState.dragging && elevationState.selected !== null) { if (JSON.stringify(elevationState.views) !== JSON.stringify(elevationState.dragSnapshot)) { pushElevationHistory(elevationState.dragSnapshot); markDirty(); persist(); } elevationState.dragging = null; elevationState.dragSnapshot = null; elevationState.dragStart = null; elevationState.dragOriginal = null; updateElevationUi(); drawElevation(); return; }
  if (elevationState.drawing) { const item = elevationState.drawing.item; if (!samePoint(item.a, item.b)) { pushElevationHistory(); view.items.push(item); elevationState.selected = view.items.length - 1; markDirty(); persist(); updateElevationUi(); } elevationState.drawing = null; drawElevation(); }
}
elevationCanvas?.addEventListener('pointerup', endElevationPointer); elevationCanvas?.addEventListener('pointercancel', endElevationPointer);
elevationCanvas?.addEventListener('wheel', (event) => { event.preventDefault(); const view = currentElevation(), anchor = elevationScreenPoint(event), world = { x: (anchor.x - view.offset.x) / view.zoom, y: (anchor.y - view.offset.y) / view.zoom }; const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1); const nextZoom = Math.max(.1, Math.min(2, view.zoom * Math.exp(-delta * .001))); view.offset = { x: anchor.x - world.x * nextZoom, y: anchor.y - world.y * nextZoom }; view.zoom = nextZoom; markDirty(); persist(); updateElevationUi(); drawElevation(); }, { passive: false });
elevationCanvas?.addEventListener('contextmenu', (event) => event.preventDefault());
function handleElevationHighlightPointerDown(event) {
  if (!elevationPageActive() || elevationState.tool !== 'select' || elevationState.selectMode !== 'highlight' || event.button !== 0 || elevationState.spacePressed) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const point = elevationSnapPoint(event);
  if (hasElevationMultiSelection() && elevationSelectedItemAtEvent(event)) { elevationState.multiDragSnapshot = elevationSnapshot(); elevationState.multiDragStart = point; elevationState.multiDragSelection = structuredClone(elevationState.selection); elevationCanvas.setPointerCapture(event.pointerId); elevationCanvas.style.cursor = 'grabbing'; drawElevation(); return; }
  elevationState.selected = null; elevationState.boxSelecting = true; elevationState.boxStart = elevationRawPoint(event); elevationState.boxCurrent = elevationState.boxStart; elevationCanvas.setPointerCapture(event.pointerId); updateElevationUi(); drawElevation();
}
function handleElevationHighlightPointerMove(event) {
  if (!elevationPageActive()) return;
  if (elevationState.boxSelecting) { event.preventDefault(); event.stopImmediatePropagation(); elevationState.boxCurrent = elevationRawPoint(event); drawElevation(); return; }
  if (elevationState.multiDragSnapshot && elevationState.multiDragSelection) { event.preventDefault(); event.stopImmediatePropagation(); const point = elevationSnapPoint(event), dx = point.x - elevationState.multiDragStart.x, dy = point.y - elevationState.multiDragStart.y; restoreElevationSnapshot(elevationState.multiDragSnapshot); moveElevationSelectionBy(elevationState.multiDragSelection, dx, dy); renderElevationList(); drawElevation(); }
}
function handleElevationHighlightPointerEnd(event) {
  if (!elevationPageActive()) return;
  if (elevationState.boxSelecting) { event.preventDefault(); event.stopImmediatePropagation(); elevationState.selection = selectElevationItemsInRect(elevationState.boxStart, elevationState.boxCurrent || elevationState.boxStart); elevationState.boxSelecting = false; elevationState.boxStart = null; elevationState.boxCurrent = null; updateElevationUi(); drawElevation(); return; }
  if (elevationState.multiDragSnapshot && elevationState.multiDragSelection) { event.preventDefault(); event.stopImmediatePropagation(); if (JSON.stringify(elevationState.views) !== JSON.stringify(elevationState.multiDragSnapshot)) { pushElevationHistory(elevationState.multiDragSnapshot); markDirty(); persist(); } elevationState.multiDragSnapshot = null; elevationState.multiDragStart = null; elevationState.multiDragSelection = null; updateElevationUi(); drawElevation(); }
}
elevationCanvas?.addEventListener('pointerdown', handleElevationHighlightPointerDown, true);
elevationCanvas?.addEventListener('pointermove', handleElevationHighlightPointerMove, true);
elevationCanvas?.addEventListener('pointerup', handleElevationHighlightPointerEnd, true);
elevationCanvas?.addEventListener('pointercancel', handleElevationHighlightPointerEnd, true);
window.addEventListener('keydown', (event) => {
  if (!elevationPageActive() || isTypingTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'c') { if (copyElevationSelection()) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
  if ((event.ctrlKey || event.metaKey) && key === 'v') { if (pasteElevationClipboard()) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
  if ((event.key === 'Delete' || event.key === 'Backspace') && deleteElevationSelection()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
$('#floorPageButton')?.addEventListener('click', () => setWorkspacePage('floor'));
$('#elevationPageButton')?.addEventListener('click', () => setWorkspacePage('elevation'));
function setWorkspacePage(page) { const elevation = page === 'elevation'; $('#floorWorkspace').hidden = elevation; $('#elevationWorkspace').hidden = !elevation; $('#floorPageButton').classList.toggle('active', !elevation); $('#elevationPageButton').classList.toggle('active', elevation); elevation ? resizeElevation() : resize(); }
function elevationPageActive() { return $('#elevationWorkspace') && !$('#elevationWorkspace').hidden; }
document.querySelectorAll('[data-elev-tool]').forEach((button) => button.addEventListener('click', () => setElevationTool(button.dataset.elevTool)));
document.querySelectorAll('[data-elev-select-mode]').forEach((button) => button.addEventListener('click', () => {
  elevationState.selectMode = button.dataset.elevSelectMode; if (elevationState.selectMode === 'single') clearElevationMultiSelection(); else elevationState.selected = null;
  document.querySelectorAll('[data-elev-select-mode]').forEach((choice) => choice.classList.toggle('active', choice === button));
  setElevationTool('select'); updateElevationUi(); drawElevation();
}));
$('#elevationViewSelect')?.addEventListener('change', (event) => { elevationState.currentView = event.target.value; elevationState.selected = null; markDirty(); persist(); updateElevationUi(); resizeElevation(); drawElevation(); });
$('#elevGridSize')?.addEventListener('change', (event) => { const view = currentElevation(), old = elevationGridPixels(); pushElevationHistory(); view.gridInches = Number(event.target.value); const scale = elevationGridPixels() / old; view.items = view.items.map((item) => item.type === 'text' ? { ...item, x: item.x * scale, y: item.y * scale } : { ...item, a: { x: item.a.x * scale, y: item.a.y * scale }, b: { x: item.b.x * scale, y: item.b.y * scale }, ...(item.labelOffset ? { labelOffset: { x: item.labelOffset.x * scale, y: item.labelOffset.y * scale } } : {}) }); markDirty(); persist(); updateElevationUi(); drawElevation(); });
$('#elevLength')?.addEventListener('change', (event) => applyElevationSelectedLength(event.target.value));
function beginElevationStyleHistory(item) { if (item && !elevationState.styleSnapshot) elevationState.styleSnapshot = elevationSnapshot(); }
function commitElevationStyleChange() { if (!elevationState.styleSnapshot) return; if (JSON.stringify(elevationState.views) !== JSON.stringify(elevationState.styleSnapshot)) pushElevationHistory(elevationState.styleSnapshot); elevationState.styleSnapshot = null; markDirty(); persist(); updateElevationUi(); drawElevation(); }
$('#elevColor')?.addEventListener('input', (event) => { elevationState.color = normalizeColor(event.target.value, ELEVATION_DEFAULT_COLOR); const item = currentElevation().items[elevationState.selected]; beginElevationStyleHistory(item); if (item) item.color = elevationState.color; markDirty(); persist(); updateElevationUi(); drawElevation(); });
$('#elevLineWidth')?.addEventListener('input', (event) => { elevationState.lineWidth = Number(event.target.value); const item = currentElevation().items[elevationState.selected]; beginElevationStyleHistory(item && item.type !== 'text' ? item : null); if (item && item.type !== 'text') item.width = elevationState.lineWidth; markDirty(); persist(); updateElevationUi(); drawElevation(); });
$('#elevTextSize')?.addEventListener('input', (event) => { elevationState.textSize = Number(event.target.value); const item = currentElevation().items[elevationState.selected]; beginElevationStyleHistory(item?.type === 'text' ? item : null); if (item?.type === 'text') item.fontSize = elevationState.textSize; markDirty(); persist(); updateElevationUi(); drawElevation(); });
$('#elevColor')?.addEventListener('change', commitElevationStyleChange);
$('#elevLineWidth')?.addEventListener('change', commitElevationStyleChange);
$('#elevTextSize')?.addEventListener('change', commitElevationStyleChange);
$('#elevZoomIn')?.addEventListener('click', () => { currentElevation().zoom = Math.min(2, currentElevation().zoom + .25); markDirty(); persist(); updateElevationUi(); drawElevation(); });
$('#elevZoomOut')?.addEventListener('click', () => { currentElevation().zoom = Math.max(.1, currentElevation().zoom - .25); markDirty(); persist(); updateElevationUi(); drawElevation(); });
$('#elevUndoButton')?.addEventListener('click', undoElevation);
$('#elevRedoButton')?.addEventListener('click', redoElevation);
$('#clearElevationButton')?.addEventListener('click', () => { const view = currentElevation(); if (!view.items.length || !confirm('Clear this elevation view?')) return; pushElevationHistory(); view.items = []; elevationState.selected = null; markDirty(); persist(); updateElevationUi(); drawElevation(); });
window.addEventListener('keydown', (event) => {
  if (!elevationPageActive()) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redoElevation() : undoElevation(); return; }
  if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redoElevation(); return; }
  if (event.code === 'Space' && !event.repeat) { elevationState.spacePressed = true; elevationCanvas.style.cursor = 'grab'; event.preventDefault(); }
  if (key === 'l') setElevationTool('line'); if (key === 'r') setElevationTool('rect'); if (key === 'd') setElevationTool('dimension'); if (key === 't') setElevationTool('text'); if (key === 'v') setElevationTool('select'); if (key === 'e') setElevationTool('erase'); if (key === 'p') setElevationTool('pan');
  if ((event.key === 'Delete' || event.key === 'Backspace') && elevationState.selected !== null) { pushElevationHistory(); currentElevation().items.splice(elevationState.selected, 1); elevationState.selected = null; markDirty(); persist(); updateElevationUi(); drawElevation(); }
  if (event.key === 'Escape') { elevationState.selected = null; updateElevationUi(); drawElevation(); }
});
window.addEventListener('keyup', (event) => { if (event.code === 'Space') { elevationState.spacePressed = false; if (elevationPageActive()) setElevationTool(elevationState.tool); } });
elevationReady = true;
new ResizeObserver(resizeElevation).observe(elevationShell);
updateElevationUi(); resizeElevation(); setElevationTool('line');
