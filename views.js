const $ = (selector) => document.querySelector(selector);
const gridPixels = (inches) => ({ 1: 12, 3: 20, 6: 25, 12: 32, 24: 44 })[inches] || 32;
const DEFAULT_WALL_COLOR = '#30332d';
const DEFAULT_SHAPE_COLOR = '#59615b';
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const normalizeColor = (value, fallback) => typeof value === 'string' && COLOR_PATTERN.test(value) ? value.toLowerCase() : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalizeOpacity = (value) => Number.isFinite(Number(value)) ? clamp(Number(value), 0, 1) : 1;
const normalizeShade = (value) => Number.isFinite(Number(value)) ? clamp(Number(value), .2, 1) : 1;

let currentProject = null;

function projectMetrics(project) {
  const gridInches = Number(project?.settings?.gridInches) || 12;
  return { gridInches, grid: gridPixels(gridInches) };
}
function pixelsToInches(project, pixels) {
  const metrics = projectMetrics(project);
  return pixels / metrics.grid * metrics.gridInches;
}
function formatLength(inches) {
  const total = Math.max(0, Math.round(inches));
  const feet = Math.floor(total / 12), inch = total % 12;
  if (!feet) return `${inch} in`;
  if (!inch) return `${feet} ft`;
  return `${feet} ft ${inch} in`;
}
function layerForItem(project, item) {
  const id = typeof item?.layerId === 'string' ? item.layerId : '';
  return (project.layers || []).find((layer) => layer.id === id) || null;
}
function itemStyle(project, item, fallback, fallbackOpacity = 1) {
  const layer = layerForItem(project, item);
  if (layer) return { visible: layer.visible !== false, color: normalizeColor(layer.color, fallback), opacity: normalizeOpacity(layer.opacity) };
  if (item?.layerId) return { visible: true, color: '#000000', opacity: 1 };
  return { visible: true, color: normalizeColor(item?.color, fallback), opacity: fallbackOpacity };
}
function wallLengthInches(project, segment) {
  return pixelsToInches(project, Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y));
}

function drawWall(ctx, project, wall) {
  const style = itemStyle(project, wall, DEFAULT_WALL_COLOR, normalizeShade(wall.shade));
  if (!style.visible) return;
  const metrics = projectMetrics(project);
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.strokeStyle = style.color;
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  ctx.lineWidth = Math.max(2, (wall.thickness || project?.settings?.wallWidth || 6) / metrics.gridInches * metrics.grid);
  ctx.beginPath();
  ctx.moveTo(wall.a.x, wall.a.y);
  ctx.lineTo(wall.b.x, wall.b.y);
  ctx.stroke();
  ctx.restore();
}
function drawLabel(ctx, project, label) {
  const style = itemStyle(project, label, '#292b26', 1);
  if (!style.visible || project?.settings?.showText === false) return;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.fillStyle = style.color;
  ctx.font = `600 ${label.fontSize || 16}px "DM Sans", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.text, label.x, label.y);
  ctx.restore();
}
function drawRuler(ctx, project, ruler) {
  const style = itemStyle(project, ruler, '#436b73', 1);
  if (!style.visible || project?.settings?.showDimensions === false) return;
  const dx = ruler.b.x - ruler.a.x, dy = ruler.b.y - ruler.a.y, length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length, ny = dx / length;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(ruler.a.x, ruler.a.y);
  ctx.lineTo(ruler.b.x, ruler.b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  [[ruler.a.x, ruler.a.y], [ruler.b.x, ruler.b.y]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.moveTo(x - nx * 6, y - ny * 6);
    ctx.lineTo(x + nx * 6, y + ny * 6);
    ctx.stroke();
  });
  const midpoint = { x: (ruler.a.x + ruler.b.x) / 2, y: (ruler.a.y + ruler.b.y) / 2 };
  const labelPos = ruler.labelOffset ? { x: midpoint.x + ruler.labelOffset.x, y: midpoint.y + ruler.labelOffset.y } : { x: midpoint.x - dy / length * 15, y: midpoint.y + dx / length * 15 };
  ctx.font = '600 11px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatLength(wallLengthInches(project, ruler)), labelPos.x, labelPos.y);
  ctx.restore();
}
function drawShape(ctx, project, shape) {
  const style = itemStyle(project, shape, DEFAULT_SHAPE_COLOR, normalizeShade(shape.shade));
  if (!style.visible) return;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (shape.type === 'line') {
    ctx.moveTo(shape.a.x, shape.a.y);
    ctx.lineTo(shape.b.x, shape.b.y);
  } else if (shape.type === 'square' || shape.type === 'rectangle') {
    ctx.rect(Math.min(shape.a.x, shape.b.x), Math.min(shape.a.y, shape.b.y), Math.abs(shape.b.x - shape.a.x), Math.abs(shape.b.y - shape.a.y));
  } else if (shape.type === 'circle') {
    ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, Math.PI * 2);
  } else {
    ctx.arc(shape.center.x, shape.center.y, shape.radius, Math.PI, Math.PI * 2);
    ctx.lineTo(shape.center.x - shape.radius, shape.center.y);
  }
  ctx.stroke();
  ctx.restore();
}
function drawObject(ctx, project, object) {
  const style = itemStyle(project, object, DEFAULT_SHAPE_COLOR, 1);
  if (!style.visible) return;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.fillStyle = style.color;
  ctx.fillRect(object.x - object.width / 2, object.y - object.height / 2, object.width, object.height);
  ctx.restore();
}

function renderView(project, view) {
  const output = $('#viewsOutput');
  const card = document.createElement('article');
  card.className = 'view-card';

  const header = document.createElement('div');
  header.className = 'view-card-header';
  const titleBlock = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = view.name || 'View';
  const meta = document.createElement('span');
  meta.textContent = `${formatLength(pixelsToInches(project, view.width))} x ${formatLength(pixelsToInches(project, view.height))}`;
  titleBlock.append(title, meta);

  const controls = document.createElement('div');
  controls.className = 'view-zoom-controls';
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.textContent = '-';
  zoomOut.setAttribute('aria-label', `Zoom out ${view.name || 'view'}`);
  const zoomLabel = document.createElement('span');
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.textContent = '+';
  zoomIn.setAttribute('aria-label', `Zoom in ${view.name || 'view'}`);
  controls.append(zoomOut, zoomLabel, zoomIn);
  header.append(titleBlock, controls);

  const wrap = document.createElement('div');
  wrap.className = 'view-canvas-wrap';
  const canvas = document.createElement('canvas');
  wrap.append(canvas);
  card.append(header, wrap);
  output.append(card);

  const viewWidth = Math.max(1, Number(view.width) || 1);
  const viewHeight = Math.max(1, Number(view.height) || 1);
  let zoom = 1;

  function fitZoom() {
    const viewportWidth = Math.max(1, wrap.clientWidth || 1);
    const viewportHeight = Math.max(1, wrap.clientHeight || 1);
    return clamp(Math.min(viewportWidth / viewWidth, viewportHeight / viewHeight, 1), .1, 4);
  }

  function draw() {
    const viewportWidth = Math.max(1, Math.floor(wrap.clientWidth || 1));
    const viewportHeight = Math.max(1, Math.floor(wrap.clientHeight || 1));
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = Math.ceil(viewportWidth * dpr);
    canvas.height = Math.ceil(viewportHeight * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, viewportWidth, viewportHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);

    const contentX = (viewportWidth - viewWidth * zoom) / 2;
    const contentY = (viewportHeight - viewHeight * zoom) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, viewportWidth, viewportHeight);
    ctx.clip();
    ctx.translate(contentX, contentY);
    ctx.scale(zoom, zoom);
    ctx.translate(-Number(view.x || 0), -Number(view.y || 0));
    (project.shapes || []).forEach((shape) => drawShape(ctx, project, shape));
    (project.objects || []).forEach((object) => drawObject(ctx, project, object));
    (project.walls || []).forEach((wall) => drawWall(ctx, project, wall));
    (project.labels || []).forEach((label) => drawLabel(ctx, project, label));
    (project.rulers || []).forEach((ruler) => drawRuler(ctx, project, ruler));
    ctx.restore();

    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  zoom = fitZoom();
  zoomOut.addEventListener('click', () => { zoom = clamp(zoom / 1.25, .1, 4); draw(); });
  zoomIn.addEventListener('click', () => { zoom = clamp(zoom * 1.25, .1, 4); draw(); });
  window.addEventListener('resize', () => draw());
  draw();
}
function renderProjectViews(project) {
  currentProject = project;
  const output = $('#viewsOutput');
  output.replaceChildren();
  const views = Array.isArray(project.views) ? project.views.filter((view) => Number(view.width) > 0 && Number(view.height) > 0) : [];
  if (!views.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-views';
    empty.textContent = 'This project does not have saved views yet.';
    output.append(empty);
    return;
  }
  views.forEach((view) => renderView(project, view));
}

async function loadProject(id) {
  $('#viewsStatus').textContent = 'Loading project...';
  $('#viewsOutput').replaceChildren();
  const response = await fetch(`./api_views.php?id=${encodeURIComponent(id)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Could not load project.');
  $('#viewsStatus').textContent = `${payload.name} - ${Array.isArray(payload.plan.views) ? payload.plan.views.length : 0} saved view(s)`;
  renderProjectViews(payload.plan);
}

async function loadProjects() {
  const select = $('#projectSelect');
  try {
    const response = await fetch('./api_views.php');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load projects.');
    select.replaceChildren();
    if (!payload.plans?.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No saved projects found';
      select.append(option);
      $('#viewsStatus').textContent = 'No saved projects found.';
      return;
    }
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a project...';
    select.append(placeholder);
    payload.plans.forEach((plan) => {
      const option = document.createElement('option');
      option.value = plan.id;
      option.textContent = `${plan.name} (${plan.viewCount || 0} views)`;
      select.append(option);
    });
    $('#viewsStatus').textContent = 'Select a project to render its saved views.';
  } catch (error) {
    select.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Could not load projects';
    select.append(option);
    $('#viewsStatus').textContent = error.message;
  }
}

$('#projectSelect').addEventListener('change', (event) => {
  if (event.target.value) loadProject(event.target.value).catch((error) => { $('#viewsStatus').textContent = error.message; });
  else $('#viewsOutput').replaceChildren();
});
loadProjects();