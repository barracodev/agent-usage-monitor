import { formatReset } from '../core/limits.js';
import { activeResetAt, formatAge, formatCountdown, meterTone, providerState } from '../core/presentation.js';
import { motionRect } from '../core/motion.js';

const providers = document.querySelector('#providers');
const widget = document.querySelector('.widget');
const content = document.querySelector('.content');
const toggle = document.querySelector('#toggle');
const windowSwitch = document.querySelector('#window-switch');
const windowButtons = document.querySelectorAll('#window-switch button');
const footer = document.querySelector('#footer');
const footerStatus = document.querySelector('#footer-status');
const settingsButton = document.querySelector('#settings');
const settingsMenu = document.querySelector('#settings-menu');
const providerSettings = document.querySelector('#provider-settings');
const emptyState = document.querySelector('#empty-state');
const emptyIcon = document.querySelector('#empty-icon');
const visibilityKey = 'usage-monitor:providers';
const knownProviders = [{ key: 'claude', name: 'Claude', installed: null }, { key: 'codex', name: 'Codex', installed: null }];
let latest = { limits: {}, providers: knownProviders };
let hasLoaded = false;
let visibility;
try { visibility = JSON.parse(localStorage.getItem(visibilityKey)) || {}; } catch { visibility = {}; }
let expanded = false;
let selectedWindow = 'session';
let settingsOpen = false;
let settingsMarkup;
let settingsTransition = 0;
let pointer = null;
let dragged = false;
let glassContrast = null;
let transition = 0;
let moveFrame = null;
let pendingMove = null;
let surfaceFrame = null;
let surfaceMotion = 0;
let surfaceBox = null;
let interactive = false;
let lastMouse = null;
let contentPin = null;
let contentOpacity = 1;
let contentFade = { motion: 0, from: 1, swapped: false };
// Último valor visto por proveedor y vista; arcos, barras y cifras parten de él.
const seen = {};
const tweens = {};
let shiftTimer;
let enterTimer;
// Compensa aquí la latencia relativa de DirectComposition y Chromium, en milisegundos.
const GLASS_LEAD_MS = 0;
// Progreso de la superficie en el que el contenido de origen ya se fundió y entra el de destino.
const CONTENT_SWAP = .35;
// Lo que tardan arcos, barras y cifras en llegar a su valor nuevo; styles.css usa lo mismo.
const VALUE_MS = 420;
// La cascada de entrada de styles.css termina antes de esto.
const ENTER_MS = 360;
const border = { x: widget.clientLeft, y: widget.clientTop };
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function surfaceRect(motion, progress) {
  const rect = motionRect(motion, progress);
  return { x: rect.x / motion.scale, y: rect.y / motion.scale, width: rect.width / motion.scale, height: rect.height / motion.scale };
}
function drawSurface(motion, progress) {
  surfaceBox = surfaceRect(motion, progress);
  Object.assign(widget.style, { left: `${surfaceBox.x}px`, top: `${surfaceBox.y}px`, width: `${surfaceBox.width}px`, height: `${surfaceBox.height}px`, right: 'auto', bottom: 'auto', transform: 'none', borderRadius: `${motion.radius}px` });
  drawContent(motion, progress);
  if (lastMouse) hitTest(lastMouse);
}
// Al abrir o cerrar, el contenido queda fijo en el rectángulo de su estado y la superficie lo
// recorta: no se reacomoda en cada frame. El de origen se funde y, desde CONTENT_SWAP, entra el
// de destino. Una inversión a medias parte de la opacidad y la posición ya pintadas.
function drawContent(motion, progress) {
  const opening = widget.classList.contains('opening');
  if (!opening && !widget.classList.contains('closing')) return;
  const arrived = () => widget.classList.contains('expanded') === opening;
  if (contentFade.motion !== motion.id) {
    contentFade = { motion: motion.id, from: contentOpacity, swapped: false };
    contentPin = arrived() ? surfaceRect(motion, 1) : contentPin || surfaceRect(motion, 0);
  }
  if (progress === 1) return showContent(opening);
  if (!arrived() && progress >= CONTENT_SWAP) {
    widget.classList.toggle('expanded', opening);
    // Al abrir, cada parte del detalle entra por su cuenta y la cascada hace el fundido. Las columnas
    // llevan su marca en el HTML: un redibujo las reemplaza y no debe repetirla.
    if (opening) {
      widget.classList.add('entering');
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => widget.classList.remove('entering'), ENTER_MS);
    }
    renderContent(opening);
    contentPin = surfaceRect(motion, 1);
    contentFade.swapped = true;
  }
  const easeOut = t => 1 - (1 - t) ** 2;
  contentOpacity = !arrived() ? contentFade.from * (1 - progress / CONTENT_SWAP)
    : contentFade.swapped ? (opening ? 1 : easeOut((progress - CONTENT_SWAP) / (1 - CONTENT_SWAP)))
    : contentFade.from + (1 - contentFade.from) * easeOut(progress);
  Object.assign(content.style, { left: `${contentPin.x - surfaceBox.x}px`, top: `${contentPin.y - surfaceBox.y}px`, width: `${contentPin.width - 2 * border.x}px`, height: `${contentPin.height - 2 * border.y}px`, opacity: String(contentOpacity) });
}
function showContent(detail) {
  contentPin = null;
  contentOpacity = 1;
  Object.assign(content.style, { left: '', top: '', width: '', height: '', opacity: '' });
  if (widget.classList.contains('expanded') === detail) return;
  widget.classList.toggle('expanded', detail);
  renderContent();
}
function animateSurface(motion) {
  if (motion.id <= surfaceMotion) return;
  surfaceMotion = motion.id;
  if (surfaceFrame !== null) cancelAnimationFrame(surfaceFrame);
  surfaceFrame = null;
  drawSurface(motion, motion.duration ? 0 : 1);
  if (!motion.duration) return;
  const startedAt = performance.now();
  const step = timestamp => {
    const elapsed = timestamp - startedAt;
    const progress = Math.min(1, Math.max(0, elapsed / motion.duration));
    const glassProgress = Math.min(1, Math.max(0, (elapsed + GLASS_LEAD_MS) / motion.duration));
    drawSurface(motion, progress);
    const complete = progress === 1 && glassProgress === 1;
    window.usageMonitor.frame(motion.id, glassProgress, complete);
    surfaceFrame = complete ? null : requestAnimationFrame(step);
  };
  surfaceFrame = requestAnimationFrame(step);
}
function hitTest(event) {
  lastMouse = { clientX: event.clientX, clientY: event.clientY };
  if (!surfaceBox) return;
  const inside = Boolean(pointer) || (event.clientX >= surfaceBox.x && event.clientX < surfaceBox.x + surfaceBox.width && event.clientY >= surfaceBox.y && event.clientY < surfaceBox.y + surfaceBox.height);
  if (inside === interactive) return;
  interactive = inside;
  void window.usageMonitor.hitTest(inside);
}

// Un dato envejecido se sigue mostrando: es el mínimo de su ventana.
const shown = state => state.key === 'live' || state.key === 'aged';

function cell(name, key, entry, period, weeklyExhausted = false, marks = '') {
  const state = providerState(entry);
  const live = shown(state);
  const value = weeklyExhausted ? 100 : live ? entry.value.usedPercent : null;
  const tone = meterTone(value);
  const exhausted = tone === 'danger';
  const activeReset = live ? activeResetAt(entry, Date.now(), key === 'claude' && period === 'weekly') : null;
  const available = live && value === 0 && !activeReset;
  const reset = activeReset ? formatReset(activeReset, period === 'weekly') : '—';
  const remaining = formatCountdown(activeReset, Date.now(), period === 'weekly');
  const figure = !live ? (state.key === 'stale' ? 'Stale' : '—') : `${Math.floor(value)}<span>%</span>`;
  const countdown = state.key === 'aged' ? formatAge(entry.fetchedAt) : activeReset ? remaining : available ? 'Sin ventana activa' : live ? 'Esperando actualización' : state.key === 'stale' ? 'Dato desactualizado' : 'Sin datos';
  const cached = Number.isFinite(entry?.value?.usedPercent);
  const quota = weeklyExhausted ? ': Sin cuota semanal' : exhausted && activeReset ? ': Sin cuota' : '';
  return `<article class="provider ${state.key} ${tone}${glassContrast?.[key] ? ' light-text' : ''}${marks}" data-provider="${key}" title="${name}${quota} · ${countdown} · Reset ${reset}">
    <strong class="name">${name}</strong>
    <div class="gauge" aria-hidden="true">
      <svg viewBox="0 0 80 80">
        <circle class="track" cx="40" cy="40" r="36"></circle>
        <circle class="fill" cx="40" cy="40" r="36" pathLength="100"></circle>
      </svg>
      <img class="provider-icon" src="icons/${key === 'claude' ? 'claude.svg' : 'codex.png'}" alt="">
    </div>
    <div class="figure ${state.key === 'stale' ? 'label' : ''}">${figure}</div>
    <div class="bar" aria-hidden="true"><div class="bar-fill"></div></div>
    <div class="detail-figure">${cached ? `${Math.floor(entry.value.usedPercent)}%` : '?'}</div>
    <div class="detail-label">${activeReset ? exhausted ? 'AGOTADO' : 'Reinicia en' : available ? 'DISPONIBLE' : cached ? 'ACTUALIZANDO' : 'Sin datos'}</div>
    <div class="detail-countdown">${activeReset ? remaining.replace(/ m$/, ' min') : available ? 'Inicia al usarla' : 'Esperando lectura'}</div>
    <div class="countdown">${countdown}</div>
    <div class="reset">${activeReset ? `Reset ${reset}` : ''}</div>
  </article>`;
}

function iconMarkup(name) { return `<span class="ui-icon icon-${name}" aria-hidden="true"></span>`; }

function providerInfo() { return latest.providers?.length ? latest.providers : knownProviders; }
function providerVisible(provider) { return provider.installed !== false && visibility[provider.key] !== false; }
function visibleProviders() { return providerInfo().filter(providerVisible); }
function syncLayout() {
  if (!hasLoaded) return Promise.resolve();
  const activeProviders = visibleProviders();
  widget.dataset.count = String(activeProviders.length);
  return window.usageMonitor.layout({ expanded, selectorOpen: settingsOpen, reduceMotion, providers: activeProviders.map(provider => provider.key) }).then(result => {
    const placement = result?.placement || result;
    if (placement) {
      widget.dataset.openHorizontal = placement.horizontal;
      widget.dataset.openVertical = placement.vertical;
    }
    if (result?.motion) animateSurface(result.motion);
    widget.classList.add('surface-ready');
    return result;
  });
}
function waitForMotion() { return window.usageMonitor.waitForMotion(); }
// Oculto solo se actualiza; a la vista, la transición CSS parte del último valor que se vio.
function morph(element, property, value, memory) {
  const previous = memory ? seen[memory] : undefined;
  if (previous !== undefined && previous !== value) { element.style[property] = previous; element.getBoundingClientRect(); }
  element.style[property] = value;
  if (memory) seen[memory] = value;
}
// La cifra cuenta desde la última que se vio. Busca su nodo en cada frame: un redibujo lo reemplaza.
function countUp(key, view, to) {
  const memory = `${key}:${view}`;
  const from = seen[memory];
  seen[memory] = to;
  if (reduceMotion || !Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
  const selector = `[data-provider="${key}"] ${view === 'detail' ? '.detail-figure' : '.figure'}`;
  const write = value => { const figure = providers.querySelector(selector); if (figure) figure.innerHTML = view === 'detail' ? `${value}%` : `${value}<span>%</span>`; };
  const startedAt = performance.now();
  const step = now => {
    const t = Math.min(1, (now - startedAt) / VALUE_MS);
    write(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    tweens[memory] = t < 1 ? requestAnimationFrame(step) : undefined;
  };
  cancelAnimationFrame(tweens[memory]);
  write(from);
  tweens[memory] = requestAnimationFrame(step);
}
function renderSettings() {
  const markup = providerInfo().map(provider => {
    if (provider.installed === false) return `<div class="provider-setting" role="group" aria-label="${provider.name}"><span><strong>${provider.name}</strong><small>No instalada</small></span><button class="install" aria-label="Instalar ${provider.name}" data-action="install" data-provider="${provider.key}">Instalar</button></div>`;
    const visible = providerVisible(provider);
    return `<div class="provider-setting" role="group" aria-label="${provider.name}"><span><strong>${provider.name}</strong><small>${provider.installed === null ? 'Detectando…' : 'Instalada'}</small></span><button class="visibility" role="checkbox" aria-checked="${visible}" aria-label="${visible ? 'Ocultar' : 'Mostrar'} ${provider.name}" data-action="toggle-provider" data-provider="${provider.key}">${iconMarkup(visible ? 'eye' : 'eye-off')}</button></div>`;
  }).join('');
  if (markup === settingsMarkup) return;
  providerSettings.innerHTML = markup;
  settingsMarkup = markup;
}

// El detalle se dibuja mientras su contenido está a la vista, también durante el cierre.
function renderContent(rise = false) {
  const activeProviders = visibleProviders();
  const detail = widget.classList.contains('expanded');
  const cells = new Map(activeProviders.map(({ key }) => {
    const windows = latest.limits[key];
    const weekly = windows?.weekly;
    const weeklyExhausted = !detail && shown(providerState(weekly)) && weekly.value.usedPercent >= 100;
    const period = detail ? selectedWindow : weeklyExhausted ? 'weekly' : 'session';
    const entry = windows?.[period];
    const number = detail ? (Number.isFinite(entry?.value?.usedPercent) ? Math.floor(entry.value.usedPercent) : null)
      : weeklyExhausted ? 100 : shown(providerState(entry)) ? Math.floor(entry.value.usedPercent) : null;
    // La cápsula late una vez cuando su cifra cruza el aviso o el agotado desde la última que se vio.
    const previous = seen[`${key}:capsule`];
    const crossed = !detail && Number.isFinite(previous) && Number.isFinite(number) && [80, 100].some(limit => previous < limit && number >= limit);
    return [key, { entry, period, weeklyExhausted, number, crossed }];
  }));
  windowSwitch.hidden = !detail;
  windowSwitch.dataset.window = selectedWindow;
  for (const button of windowButtons) button.setAttribute('aria-pressed', String(button.dataset.window === selectedWindow));
  widget.dataset.count = String(activeProviders.length);
  providers.dataset.count = String(activeProviders.length);
  providers.hidden = activeProviders.length === 0;
  emptyState.hidden = activeProviders.length !== 0;
  providers.innerHTML = activeProviders.map(({ name, key }) => {
    const { entry, period, weeklyExhausted, crossed } = cells.get(key);
    return cell(name, key, entry, period, weeklyExhausted, `${crossed ? ' crossed' : ''}${rise ? ' rise' : ''}`);
  }).join('');
  for (const element of providers.children) {
    const key = element.dataset.provider;
    const { entry, weeklyExhausted, number } = cells.get(key) || {};
    const percent = weeklyExhausted ? 100 : shown(providerState(entry)) ? entry.value.usedPercent : 0;
    // CSSOM actualiza arco y barra sin abrir la CSP a estilos inline.
    morph(element.querySelector('.fill'), 'strokeDasharray', `${percent} 100`, !detail && `${key}:arc`);
    morph(element.querySelector('.bar-fill'), 'height', `${Number.isFinite(entry?.value?.usedPercent) ? entry.value.usedPercent : 0}%`, detail && `${key}:bar`);
    countUp(key, detail ? 'detail' : 'capsule', number);
  }
  const entries = activeProviders.map(({ key }) => cells.get(key).entry);
  const old = entries.find(entry => ['aged', 'stale'].includes(providerState(entry).key));
  const stamps = entries.map(entry => entry?.fetchedAt).filter(Number.isFinite);
  const oldProvider = old && activeProviders[entries.indexOf(old)];
  footerStatus.classList.toggle('outdated', Boolean(old));
  footerStatus.innerHTML = old ? `⚠ ${oldProvider.name} · ${Number.isFinite(old.fetchedAt) ? formatAge(old.fetchedAt) : 'Sin lectura reciente'}` : stamps.length ? `${iconMarkup('refresh-cw')}<span>${formatReset(Math.min(...stamps))}</span>` : 'Esperando lectura';
  footerStatus.setAttribute('aria-label', stamps.length && !old ? `Actualizado ${formatReset(Math.min(...stamps))}` : footerStatus.textContent || 'Estado de actualización');
  footer.classList.toggle('light-text', glassContrast?.footer === true);
  windowSwitch.classList.toggle('light-text', glassContrast?.window === true);
  emptyState.classList.toggle('light-text', glassContrast?.footer === true);
  settingsMenu.classList.toggle('light-text', glassContrast?.footer === true);
  renderSettings();
}

function render() {
  renderContent();
  return syncLayout();
}

async function openSettings() {
  if (!expanded || settingsOpen) return;
  const current = ++settingsTransition;
  settingsOpen = true;
  widget.classList.add('selector-open');
  settingsButton.setAttribute('aria-expanded', 'true');
  renderSettings();
  await syncLayout();
  await waitForMotion();
  if (current !== settingsTransition || !settingsOpen || !expanded) return;
  settingsMenu.hidden = false;
  requestAnimationFrame(() => { if (current === settingsTransition && settingsOpen && expanded) settingsMenu.classList.add('open'); });
}

async function closeSettings(resize = true) {
  if (!settingsOpen) return;
  const current = ++settingsTransition;
  settingsOpen = false;
  settingsButton.setAttribute('aria-expanded', 'false');
  settingsMenu.classList.remove('open');
  await new Promise(resolve => setTimeout(resolve, reduceMotion ? 1 : 140));
  if (current !== settingsTransition) return;
  settingsMenu.hidden = true;
  widget.classList.remove('selector-open');
  if (resize) { await syncLayout(); await waitForMotion(); }
}

async function setExpanded(value) {
  const current = ++transition;
  if (!value) expanded = false;
  if (!value && settingsOpen) await closeSettings(false);
  if (current !== transition) return;
  toggle.setAttribute('aria-expanded', String(value));
  toggle.setAttribute('aria-label', value ? 'Ocultar detalle de uso' : 'Mostrar detalle de uso');
  expanded = value;
  // Antes de pedir la animación: sus frames cambian el contenido según hacia dónde va.
  widget.classList.toggle('opening', value);
  widget.classList.toggle('closing', !value);
  await render();
  await waitForMotion();
  if (current !== transition) return;
  showContent(value);
  widget.classList.remove(value ? 'opening' : 'closing');
  if (!value) return render();
}

toggle.addEventListener('click', event => { if (!dragged || event.detail === 0) setExpanded(!expanded); });
toggle.addEventListener('keydown', event => { if (event.key === 'Escape') setExpanded(false); });
toggle.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragged = false;
  pointer = { x: event.screenX, y: event.screenY, windowX: window.screenX + (surfaceBox ? surfaceBox.x - 28 : 0), windowY: window.screenY + (surfaceBox ? surfaceBox.y - 20 : 0) };
  toggle.setPointerCapture(event.pointerId);
});
toggle.addEventListener('pointermove', event => {
  if (!pointer) return;
  const dx = event.screenX - pointer.x;
  const dy = event.screenY - pointer.y;
  if (Math.hypot(dx, dy) > 4) dragged = true;
  if (dragged) {
    widget.classList.add('dragging');
    pendingMove = [pointer.windowX + dx, pointer.windowY + dy];
    if (moveFrame === null) moveFrame = requestAnimationFrame(() => {
      moveFrame = null;
      const target = pendingMove;
      pendingMove = null;
      if (target) void window.usageMonitor.move(...target);
    });
  }
});
toggle.addEventListener('pointerup', event => {
  if (moveFrame !== null) cancelAnimationFrame(moveFrame);
  moveFrame = null;
  if (pendingMove) void window.usageMonitor.move(...pendingMove);
  pendingMove = null;
  pointer = null;
  widget.classList.remove('dragging');
  toggle.releasePointerCapture(event.pointerId);
});
toggle.addEventListener('pointercancel', () => { if (moveFrame !== null) cancelAnimationFrame(moveFrame); moveFrame = null; pendingMove = null; pointer = null; dragged = true; widget.classList.remove('dragging'); });

async function refresh(force = false) {
  try { latest = await window.usageMonitor.read(force); }
  catch { for (const windows of Object.values(latest.limits)) for (const entry of Object.values(windows)) entry.stale = true; }
  hasLoaded = true;
  render();
}

settingsButton.innerHTML = iconMarkup('settings');
emptyIcon.innerHTML = iconMarkup('eye-off');
for (const button of windowButtons) button.addEventListener('click', event => {
  event.stopPropagation();
  if (button.dataset.window !== selectedWindow) {
    // Los valores nuevos entran desde el lado hacia el que se mueve el indicador.
    providers.dataset.shift = button.dataset.window === 'weekly' ? 'forward' : 'back';
    clearTimeout(shiftTimer);
    shiftTimer = setTimeout(() => { delete providers.dataset.shift; }, 300);
  }
  selectedWindow = button.dataset.window;
  render();
});
settingsButton.addEventListener('click', event => { event.stopPropagation(); settingsOpen ? void closeSettings() : void openSettings(); });
document.addEventListener('pointerdown', event => { if (settingsOpen && !settingsMenu.contains(event.target) && !settingsButton.contains(event.target)) void closeSettings(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && settingsOpen) { event.stopPropagation(); void closeSettings(); } });
document.addEventListener('mousemove', hitTest);
document.addEventListener('mouseleave', event => hitTest({ clientX: -1, clientY: -1 }));
providerSettings.addEventListener('click', async event => {
  const target = event.target.closest?.('[data-action]') || event.target;
  const key = target.dataset.provider;
  if (target.dataset.action === 'toggle-provider' && providerInfo().some(provider => provider.key === key && provider.installed !== false)) {
    visibility[key] = visibility[key] === false;
    localStorage.setItem(visibilityKey, JSON.stringify(visibility));
    render();
  }
  if (target.dataset.action === 'install' && providerInfo().some(provider => provider.key === key && provider.installed === false)) {
    await window.usageMonitor.openInstall(key);
  }
});
// El proceso principal empuja cada dato nuevo; la lectura periódica solo recalcula caducidad.
window.usageMonitor.onUpdate(data => { latest = data; render(); });
window.usageMonitor.onSurface(animateSurface);
window.usageMonitor.onGlass(contrast => {
  glassContrast = contrast;
  widget.classList.toggle('glass', true);
  render();
});
render();
refresh();
setInterval(() => void refresh(), 30000);
setInterval(render, 60000);
