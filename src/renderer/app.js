import { formatReset } from '../core/limits.js';
import { activeResetAt, formatAge, formatCountdown, meterTone, providerState } from '../core/presentation.js';

const providers = document.querySelector('#providers');
const widget = document.querySelector('.widget');
const toggle = document.querySelector('#toggle');
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
let settingsOpen = false;
let settingsTransition = 0;
let pointer = null;
let dragged = false;
let glassContrast = null;
let transition = 0;
let moveFrame = null;
let pendingMove = null;
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// Un dato envejecido se sigue mostrando: es el mínimo de su ventana.
const shown = state => state.key === 'live' || state.key === 'aged';

function cell(name, key, entry) {
  const state = providerState(entry);
  const live = shown(state);
  const value = live ? entry.value.usedPercent : null;
  const tone = meterTone(value);
  const exhausted = tone === 'danger';
  const activeReset = live ? activeResetAt(entry) : null;
  const available = live && value === 0 && !activeReset;
  const reset = activeReset ? formatReset(activeReset) : '—';
  const figure = !live ? (state.key === 'stale' ? 'Stale' : '—') : `${Math.floor(value)}<span>%</span>`;
  const countdown = state.key === 'aged' ? formatAge(entry.fetchedAt) : activeReset ? formatCountdown(activeReset) : available ? 'Sin ventana activa' : live ? 'Esperando actualización' : state.key === 'stale' ? 'Dato desactualizado' : 'Sin datos';
  const cached = Number.isFinite(entry?.value?.usedPercent);
  return `<article class="provider ${state.key} ${tone}${glassContrast?.[key] ? ' light-text' : ''}" data-provider="${key}" title="${name}${exhausted && activeReset ? ': Sin cuota' : ''} · ${countdown} · Reset ${reset}">
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
    <div class="detail-countdown">${activeReset ? formatCountdown(activeReset).replace(/ m$/, ' min') : available ? 'Inicia al usarla' : 'Esperando lectura'}</div>
    <div class="countdown">${countdown}</div>
    <div class="reset">${activeReset ? `Reset ${formatReset(activeReset)}` : ''}</div>
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
    return result;
  });
}
function waitForMotion() { return window.usageMonitor.waitForMotion(); }
function renderSettings() {
  providerSettings.innerHTML = providerInfo().map(provider => {
    if (provider.installed === false) return `<div class="provider-setting" role="group" aria-label="${provider.name}"><span><strong>${provider.name}</strong><small>No instalada</small></span><button class="install" aria-label="Instalar ${provider.name}" data-action="install" data-provider="${provider.key}">Instalar</button></div>`;
    const visible = providerVisible(provider);
    return `<div class="provider-setting" role="group" aria-label="${provider.name}"><span><strong>${provider.name}</strong><small>${provider.installed === null ? 'Detectando…' : 'Instalada'}</small></span><button class="visibility" role="checkbox" aria-checked="${visible}" aria-label="${visible ? 'Ocultar' : 'Mostrar'} ${provider.name}" data-action="toggle-provider" data-provider="${provider.key}">${iconMarkup(visible ? 'eye' : 'eye-off')}</button></div>`;
  }).join('');
}

function render() {
  const activeProviders = visibleProviders();
  widget.dataset.count = String(activeProviders.length);
  providers.dataset.count = String(activeProviders.length);
  providers.hidden = activeProviders.length === 0;
  emptyState.hidden = activeProviders.length !== 0;
  providers.innerHTML = activeProviders.map(provider => cell(provider.name, provider.key, latest.limits[provider.key])).join('');
  for (const element of providers.children) {
    const entry = latest.limits[element.dataset.provider];
    // CSSOM actualiza el arco sin abrir la CSP a estilos inline.
    element.querySelector('.fill').style.strokeDasharray = `${shown(providerState(entry)) ? entry.value.usedPercent : 0} 100`;
    element.querySelector('.bar-fill').style.height = `${Number.isFinite(entry?.value?.usedPercent) ? entry.value.usedPercent : 0}%`;
  }
  const entries = activeProviders.map(provider => latest.limits[provider.key]);
  const old = entries.find(entry => ['aged', 'stale'].includes(providerState(entry).key));
  const stamps = entries.map(entry => entry?.fetchedAt).filter(Number.isFinite);
  const oldProvider = old && activeProviders[entries.indexOf(old)];
  footerStatus.classList.toggle('outdated', Boolean(old));
  footerStatus.innerHTML = old ? `⚠ ${oldProvider.name} · ${Number.isFinite(old.fetchedAt) ? formatAge(old.fetchedAt) : 'Sin lectura reciente'}` : stamps.length ? `${iconMarkup('refresh-cw')}<span>${formatReset(Math.min(...stamps))}</span>` : 'Esperando lectura';
  footerStatus.setAttribute('aria-label', stamps.length && !old ? `Actualizado ${formatReset(Math.min(...stamps))}` : footerStatus.textContent || 'Estado de actualización');
  footer.classList.toggle('light-text', glassContrast?.footer === true);
  settingsMenu.classList.toggle('light-text', glassContrast?.footer === true);
  renderSettings();
  void syncLayout();
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
  if (value) {
    expanded = true;
    await syncLayout();
    if (current !== transition) return;
    widget.classList.remove('closing');
    widget.classList.add('expanded');
    widget.classList.add('opening');
    await waitForMotion();
    if (current !== transition) return;
    widget.classList.remove('opening');
    return;
  }
  widget.classList.remove('opening');
  widget.classList.add('closing');
  await syncLayout();
  await waitForMotion();
  if (current !== transition) return;
  widget.classList.remove('expanded');
  widget.classList.remove('closing');
}

toggle.addEventListener('click', event => { if (!dragged || event.detail === 0) setExpanded(!expanded); });
toggle.addEventListener('keydown', event => { if (event.key === 'Escape') setExpanded(false); });
toggle.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragged = false;
  pointer = { x: event.screenX, y: event.screenY, windowX: window.screenX, windowY: window.screenY };
  toggle.setPointerCapture(event.pointerId);
});
toggle.addEventListener('pointermove', event => {
  if (!pointer) return;
  const dx = event.screenX - pointer.x;
  const dy = event.screenY - pointer.y;
  if (Math.hypot(dx, dy) > 4) dragged = true;
  if (dragged) {
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
  toggle.releasePointerCapture(event.pointerId);
});
toggle.addEventListener('pointercancel', () => { if (moveFrame !== null) cancelAnimationFrame(moveFrame); moveFrame = null; pendingMove = null; pointer = null; dragged = true; });

async function refresh(force = false) {
  try { latest = await window.usageMonitor.read(force); }
  catch { for (const entry of Object.values(latest.limits)) entry.stale = true; }
  hasLoaded = true;
  render();
}

settingsButton.innerHTML = iconMarkup('settings');
emptyIcon.innerHTML = iconMarkup('eye-off');
settingsButton.addEventListener('click', event => { event.stopPropagation(); settingsOpen ? void closeSettings() : void openSettings(); });
document.addEventListener('pointerdown', event => { if (settingsOpen && !settingsMenu.contains(event.target) && !settingsButton.contains(event.target)) void closeSettings(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && settingsOpen) { event.stopPropagation(); void closeSettings(); } });
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
window.usageMonitor.onGlass(contrast => {
  glassContrast = contrast;
  widget.classList.toggle('glass', true);
  render();
});
render();
refresh();
setInterval(() => void refresh(), 30000);
setInterval(render, 60000);
