const canvas = document.querySelector('#planCanvas');
const ctx = canvas.getContext('2d');
const shell = canvas.parentElement;
const $ = (selector) => document.querySelector(selector);
const gridPixels = (inches) => ({ 3: 20, 6: 25, 12: 32, 24: 44 })[inches] || 32;

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
  walls: saved.walls || [], labels: saved.labels || [], history: [], future: [], tool: 'wall',
  drawing: false, panning: false, start: null, preview: null, panPointer: null, spacePressed: false,
  selectedWall: null, editingHandle: null, editSnapshot: null,
  selectedLabel: null, draggingLabel: false, labelSnapshot: null, labelDragOffset: null, labelSizeSnapshot: null,
  serverId: saved.server?.id || null, serverName: saved.server?.name || 'Untitled plan',
  dirty: saved.localState?.dirty === true,
  zoom: Number(saved.viewport?.zoom) || 1,
  offset: { x: Number(saved.viewport?.offset?.x) || 0, y: Number(saved.viewport?.offset?.y) || 0 },
  gridInches: Number(saved.settings?.gridInches) || 12,
  wallWidth: Number(saved.settings?.wallWidth) || 6,
  grid: 32, dpr: window.devicePixelRatio || 1,
};
state.grid = gridPixels(state.gridInches);

const documentSnapshot = () => structuredClone({ walls: state.walls, labels: state.labels });
function restoreSnapshot(snapshot) {
  state.walls = structuredClone(snapshot.walls || []);
  state.labels = structuredClone(snapshot.labels || []);
}
function pushHistory(snapshot = documentSnapshot()) {
  state.history.push(snapshot); if (state.history.length > 100) state.history.shift();
  state.future = [];
}
function markDirty() { state.dirty = true; }

const snap = (value) => Math.round(value / state.grid) * state.grid;
const samePoint = (a, b) => a.x === b.x && a.y === b.y;
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

function wallLengthInches(wall) {
  return Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) / state.grid * state.gridInches;
}

function formatLength(inches) {
  const total = Math.max(0, Math.round(inches));
  const feet = Math.floor(total / 12), remainder = total % 12;
  if (!feet) return `${remainder} in`;
  return remainder ? `${feet} ft ${remainder} in` : `${feet} ft`;
}

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

function drawMeasurement(wall, preview) {
  const ax = state.offset.x + wall.a.x * state.zoom, ay = state.offset.y + wall.a.y * state.zoom;
  const bx = state.offset.x + wall.b.x * state.zoom, by = state.offset.y + wall.b.y * state.zoom;
  const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
  const wallPixels = Math.max(2, state.wallWidth / state.gridInches * state.grid * state.zoom);
  const side = dy > 0 || (dy === 0 && dx < 0) ? -1 : 1;
  const distance = wallPixels / 2 + 13;
  const x = (ax + bx) / 2 + -dy / length * distance * side;
  const y = (ay + by) / 2 + dx / length * distance * side;
  const label = formatLength(wallLengthInches(wall));
  ctx.save();
  ctx.font = '600 11px "DM Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const labelWidth = ctx.measureText(label).width + 12;
  ctx.fillStyle = preview ? 'rgba(247,244,236,.88)' : 'rgba(247,244,236,.95)';
  ctx.fillRect(x - labelWidth / 2, y - 10, labelWidth, 20);
  ctx.fillStyle = preview ? '#a34329' : '#4f514a'; ctx.fillText(label, x, y + .5); ctx.restore();
}

function drawWall(wall, preview = false, selected = false) {
  ctx.save(); ctx.translate(state.offset.x, state.offset.y); ctx.scale(state.zoom, state.zoom);
  ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
  ctx.strokeStyle = preview || selected ? '#b54b2d' : '#30332d'; ctx.globalAlpha = preview ? .65 : 1;
  ctx.lineWidth = Math.max(2, state.wallWidth / state.gridInches * state.grid);
  ctx.beginPath(); ctx.moveTo(wall.a.x, wall.a.y); ctx.lineTo(wall.b.x, wall.b.y); ctx.stroke(); ctx.restore();
  drawMeasurement(wall, preview);
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

function draw() {
  const width = canvas.width / state.dpr, height = canvas.height / state.dpr;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#e7e3d8'; ctx.fillRect(0, 0, width, height); drawGrid(width, height);
  state.walls.forEach((wall, index) => drawWall(wall, false, state.tool === 'edit' && index === state.selectedWall));
  state.labels.forEach((label, index) => drawLabel(label, state.tool === 'text' && index === state.selectedLabel));
  if (state.preview) drawWall(state.preview, true);
  if (state.tool === 'edit' && state.selectedWall !== null && state.walls[state.selectedWall]) drawEditHandles(state.walls[state.selectedWall]);
}

function projectData() {
  return {
    format: 'gridline-floor-plan', version: 2, exportedAt: new Date().toISOString(),
    settings: { gridInches: state.gridInches, wallWidth: state.wallWidth },
    viewport: { zoom: state.zoom, offset: { ...state.offset } },
    walls: state.walls.map((wall) => ({ a: { ...wall.a }, b: { ...wall.b } })),
    labels: state.labels.map((label) => ({ text: label.text, x: label.x, y: label.y, fontSize: label.fontSize || 16 })),
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

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
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
    item.addEventListener('click', () => { setTool('edit'); state.selectedWall = index; updateUi(); draw(); });
  });
  $('#totalLength').textContent = formatLength(state.walls.reduce((sum, wall) => sum + wallLengthInches(wall), 0));

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
}

function updateUi() {
  $('#wallCount').textContent = `${state.walls.length} wall${state.walls.length === 1 ? '' : 's'}`;
  $('#undoButton').disabled = !state.history.length; $('#redoButton').disabled = !state.future.length;
  $('#gridSize').value = String(state.gridInches); $('#wallWidth').value = String(state.wallWidth);
  $('#wallWidthValue').textContent = `${state.wallWidth} in`; $('#zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#projectName').textContent = state.serverName || 'Untitled plan';
  const selectedLabel = state.selectedLabel !== null ? state.labels[state.selectedLabel] : null;
  $('#labelSize').disabled = !selectedLabel;
  if (selectedLabel) { $('#labelSize').value = String(selectedLabel.fontSize || 16); $('#labelSizeValue').textContent = `${selectedLabel.fontSize || 16}px`; }
  else { $('#labelSizeValue').textContent = '—'; }
  renderWallList();
}

function setCanvasCursor() {
  canvas.style.cursor = state.panning || state.editingHandle || state.draggingLabel ? 'grabbing' : state.spacePressed || state.tool === 'pan' ? 'grab' : state.tool === 'wall' ? 'crosshair' : state.tool === 'edit' || state.tool === 'text' ? 'pointer' : 'cell';
}

function beginPan(event) {
  state.panning = true; state.panPointer = screenPoint(event); canvas.setPointerCapture(event.pointerId); setCanvasCursor();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1 || state.tool === 'pan' || state.spacePressed) { event.preventDefault(); beginPan(event); return; }
  if (event.button !== 0) return;
  const point = canvasPoint(event);
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
    }
    if (handle) {
      state.editingHandle = handle; state.editSnapshot = documentSnapshot();
      canvas.setPointerCapture(event.pointerId); setCanvasCursor();
    }
    draw(); return;
  }
  if (state.tool === 'erase') {
    const labelIndex = labelAtPoint(rawCanvasPoint(event));
    if (labelIndex >= 0) { commitLabels(state.labels.filter((_, i) => i !== labelIndex)); return; }
    let index = -1;
    for (let i = state.walls.length - 1; i >= 0; i -= 1) {
      if (pointToSegmentDistance(point, state.walls[i].a, state.walls[i].b) < 18 / state.zoom) { index = i; break; }
    }
    if (index >= 0) commit(state.walls.filter((_, i) => i !== index)); return;
  }
  state.drawing = true; state.start = point; state.preview = { a: point, b: point }; canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (state.panning) {
    const point = screenPoint(event); state.offset.x += point.x - state.panPointer.x; state.offset.y += point.y - state.panPointer.y;
    state.panPointer = point; draw(); return;
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
  state.preview = { a: state.start, b: point }; draw();
});

function endPointer() {
  if (state.panning) { state.panning = false; state.panPointer = null; markDirty(); persist(); setCanvasCursor(); return; }
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
  state.editingHandle = null; state.editSnapshot = null;
  state.draggingLabel = false; state.labelSnapshot = null; state.labelDragOffset = null;
  state.labelSizeSnapshot = null;
  if (tool !== 'edit') state.selectedWall = null;
  if (tool !== 'text') state.selectedLabel = null;
  state.tool = tool;
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  const content = {
    wall: ['Wall tool', 'Drag between grid points · Hold Shift for a straight wall'],
    edit: ['Edit tool', 'Select a wall, then drag either endpoint'],
    text: ['Text tool', 'Click to add · Drag to move · Double-click to edit'],
    erase: ['Erase tool', 'Click a wall to remove it'], pan: ['Pan tool', 'Drag to move the grid and plan'],
  }[tool];
  $('#modeLabel').textContent = content[0]; $('#modeHelp').textContent = content[1]; setCanvasCursor(); updateUi(); draw();
}

function undo() {
  if (!state.history.length) return; state.future.push(documentSnapshot());
  restoreSnapshot(state.history.pop()); state.selectedWall = null; state.selectedLabel = null; markDirty(); persist(); draw(); updateUi();
}
function redo() {
  if (!state.future.length) return; state.history.push(documentSnapshot());
  restoreSnapshot(state.future.pop()); state.selectedWall = null; state.selectedLabel = null; markDirty(); persist(); draw(); updateUi();
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
  state.walls = project.walls.map((wall) => ({ a: { x: Number(wall.a.x), y: Number(wall.a.y) }, b: { x: Number(wall.b.x), y: Number(wall.b.y) } }));
  state.labels = (project.labels || []).map((label) => {
    const size = Number(label.fontSize);
    return { text: label.text.slice(0, 200), x: Number(label.x), y: Number(label.y), fontSize: Number.isFinite(size) ? Math.max(10, Math.min(48, Math.round(size))) : 16 };
  });
  if ([3, 6, 12, 24].includes(Number(project.settings?.gridInches))) state.gridInches = Number(project.settings.gridInches);
  if (Number(project.settings?.wallWidth) >= 3 && Number(project.settings?.wallWidth) <= 12) state.wallWidth = Number(project.settings.wallWidth);
  state.grid = gridPixels(state.gridInches);
  if (Number.isFinite(Number(project.viewport?.zoom))) state.zoom = Math.max(.1, Math.min(2, Number(project.viewport.zoom)));
  if (validPoint(project.viewport?.offset)) state.offset = { x: Number(project.viewport.offset.x), y: Number(project.viewport.offset.y) };
  const fromServer = Object.prototype.hasOwnProperty.call(options, 'serverId');
  state.serverId = fromServer ? options.serverId : null;
  state.serverName = fromServer ? (options.serverName || 'Untitled plan') : 'Untitled plan';
  state.dirty = false;
  state.history = []; state.future = []; state.selectedWall = null; state.selectedLabel = null;
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

async function saveServerPlan() {
  const name = prompt('Plan name:', state.serverName || 'Untitled plan');
  if (!name || !name.trim()) return false;
  try {
    $('#saveStatus').textContent = 'Saving to server…';
    const payload = await apiRequest('./api.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.serverId, name: name.trim().slice(0, 100), plan: projectData() }),
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
  state.walls = []; state.labels = []; state.history = []; state.future = [];
  state.selectedWall = null; state.selectedLabel = null; state.editingHandle = null; state.draggingLabel = false;
  state.start = null; state.preview = null; state.zoom = 1; state.offset = { x: 0, y: 0 };
  state.gridInches = 12; state.grid = gridPixels(12); state.wallWidth = 6;
  state.serverId = null; state.serverName = 'Untitled plan'; state.dirty = false;
  persist(); updateUi(); draw(); setTool('wall'); $('#saveStatus').textContent = 'New project';
}

function requestNewProject() {
  if (!state.dirty) { resetProject(); return; }
  $('#newProjectDialog').showModal();
}

document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
$('#undoButton').addEventListener('click', undo); $('#redoButton').addEventListener('click', redo);
$('#centerButton').addEventListener('click', () => { if (state.offset.x || state.offset.y) markDirty(); state.offset = { x: 0, y: 0 }; persist(); draw(); });
$('#clearButton').addEventListener('click', () => {
  if ((!state.walls.length && !state.labels.length) || !confirm('Clear the entire floor plan?')) return;
  pushHistory(); state.walls = []; state.labels = []; state.selectedWall = null; state.selectedLabel = null; markDirty(); persist(); updateUi(); draw();
});
$('#wallWidth').addEventListener('input', (event) => { state.wallWidth = Number(event.target.value); markDirty(); persist(); updateUi(); draw(); });
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
  state.walls = state.walls.map((wall) => ({ a: { x: wall.a.x * scale, y: wall.a.y * scale }, b: { x: wall.b.x * scale, y: wall.b.y * scale } }));
  state.labels = state.labels.map((label) => ({ ...label, x: label.x * scale, y: label.y * scale }));
  markDirty(); persist(); updateUi(); draw();
});
function setZoom(value) { state.zoom = Math.max(.1, Math.min(2, value)); markDirty(); persist(); updateUi(); draw(); }
$('#zoomIn').addEventListener('click', () => setZoom(state.zoom + .25)); $('#zoomOut').addEventListener('click', () => setZoom(state.zoom - .25));
$('#saveButton').addEventListener('click', downloadJson); $('#loadButton').addEventListener('click', () => $('#loadInput').click());
$('#loadInput').addEventListener('change', (event) => event.target.files[0] && loadJson(event.target.files[0]));
$('#serverSaveButton').addEventListener('click', saveServerPlan);
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
  if (event.key.toLowerCase() === 'w') setTool('wall'); if (event.key.toLowerCase() === 'v') setTool('edit'); if (event.key.toLowerCase() === 't') setTool('text'); if (event.key.toLowerCase() === 'e') setTool('erase'); if (event.key.toLowerCase() === 'p') setTool('pan');
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.tool === 'text' && state.selectedLabel !== null) {
    event.preventDefault(); const selected = state.selectedLabel; state.selectedLabel = null; commitLabels(state.labels.filter((_, index) => index !== selected));
  }
  if (event.key === 'Escape') { state.selectedWall = null; state.selectedLabel = null; updateUi(); draw(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
});
window.addEventListener('keyup', (event) => { if (event.code === 'Space') { state.spacePressed = false; setCanvasCursor(); } });
window.addEventListener('blur', () => { state.spacePressed = false; if (!state.panning) setCanvasCursor(); });
window.addEventListener('beforeunload', (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
new ResizeObserver(resize).observe(shell);
updateUi(); resize(); setTool('wall'); persist();
