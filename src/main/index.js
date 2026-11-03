import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron';
import glass from '@hicccc77/electron-liquid-glass';
import { mkdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectClaude, projectCodex } from '../core/limits.js';
import { MOTION_MS, motionRect } from '../core/motion.js';
import { createClaudeClient, createCodexClient } from './data.js';
import { resolveExecutable } from './process.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_MARGIN = { width: 56, height: 56 };
const COLLAPSED_WIDGET_WIDTH = 42;
const EMPTY_WIDGET_WIDTH = 150;
const COLLAPSED_FRAME_HEIGHT = 16;
const PROVIDER_HEIGHT = 50;
const PROVIDER_GAP = 22;
const EXPANDED_WIDGET_HEIGHT = 200;
const EXPANDED_COLUMN_WIDTH = 154;
const EXPANDED_BASE_WIDTH = 20;
const SELECTOR_WIDGET_WIDTH = 328;
// Codex no avisa de lo que consumen otras instancias: su app-server solo emite cambios de sus
// propios turnos, así que se lee al backend cuando cambia una sesión local y, para el uso desde
// otros equipos, también cada 15 s. Claude consulta el uso de cuenta sin enviar prompts.
const CLAUDE_POLL_MS = 60000;
const CODEX_POLL_MS = 15000;
const CODEX_RETRY_MS = 60000;
const CODEX_KICK_MS = 2000;
const PROVIDERS = Object.freeze([
  { key: 'claude', name: 'Claude', command: 'claude', installUrl: 'https://code.claude.com/docs/en/getting-started' },
  { key: 'codex', name: 'Codex', command: 'codex', installUrl: 'https://learn.chatgpt.com/docs/codex/cli' },
]);
let mainWindow;
let tray;
let quitting = false;
let panelLayout = { expanded: false, selectorOpen: false, providers: ['claude', 'codex'] };
let layoutPlacement = { horizontal: 'left', vertical: 'down' };
let layoutTarget = null;
let initialPosition = null;
let boundsAnimation = 0;
let boundsMotion = Promise.resolve();
let activeMotion = null;
let surfaceBounds = null;
let surfaceWindowOrigin = null;
let surfacePixels = null;
let surfaceScale;
let hostReady = false;
let positioningHost = false;
let glassMorph = 0;
let glassPanel;
let glassScale;
let glassLightText = { claude: false, codex: false, footer: false };
let glassBandKeys = [];
let glassCapturePolicy = 'all';
let glassHidden = false;
let saveTimer;
let codexTimer;
let codexKick;
let codexRead = null;
let codexWatcher = null;
let claudeTimer;
let claudeRead = null;
const claude = createClaudeClient();
const codex = createCodexClient();
let limitsCache = { claude: { value: null }, codex: { value: null } };
const settingsPath = () => path.join(app.getPath('userData'), 'window.json');

function detectedProviders() {
  return PROVIDERS.map(({ key, name, command }) => ({ key, name, installed: Boolean(resolveExecutable(command)) }));
}
function normalizeProviderKeys(keys) {
  if (!Array.isArray(keys)) throw new Error('Proveedores de panel inválidos');
  const allowed = new Set(PROVIDERS.map(provider => provider.key));
  const unique = [...new Set(keys)];
  if (unique.length !== keys.length || unique.some(key => !allowed.has(key))) throw new Error('Proveedores de panel inválidos');
  return unique;
}
function layoutSize(layout = panelLayout) {
  const count = layout.providers.length;
  if (!layout.expanded) {
    const slots = Math.max(1, count);
    const widgetHeight = COLLAPSED_FRAME_HEIGHT + slots * PROVIDER_HEIGHT + (slots - 1) * PROVIDER_GAP;
    const widgetWidth = count ? COLLAPSED_WIDGET_WIDTH : EMPTY_WIDGET_WIDTH;
    return { width: widgetWidth + WINDOW_MARGIN.width, height: widgetHeight + WINDOW_MARGIN.height };
  }
  const columns = Math.max(1, count);
  const adaptiveWidth = EXPANDED_BASE_WIDTH + columns * EXPANDED_COLUMN_WIDTH;
  const widgetWidth = layout.selectorOpen ? Math.max(adaptiveWidth, SELECTOR_WIDGET_WIDTH) : adaptiveWidth;
  return { width: widgetWidth + WINDOW_MARGIN.width, height: EXPANDED_WIDGET_HEIGHT + WINDOW_MARGIN.height };
}
function placementFor(bounds, area) {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const horizontal = centerX < area.x + area.width / 2 ? 'right' : 'left';
  const relativeY = (centerY - area.y) / area.height;
  const vertical = relativeY < 1 / 3 ? 'down' : relativeY >= 2 / 3 ? 'up' : 'center';
  return { horizontal, vertical };
}
function placeBounds(bounds, previous, size, placement) {
  const x = placement.horizontal === 'left' ? bounds.x + previous.width - size.width : bounds.x;
  const y = placement.vertical === 'up' ? bounds.y + previous.height - size.height
    : placement.vertical === 'center' ? bounds.y + (previous.height - size.height) / 2 : bounds.y;
  return { x: Math.round(x), y: Math.round(y), ...size };
}
function getSurfaceBounds() {
  const host = mainWindow.getBounds();
  if (!surfaceBounds) return host;
  return { ...surfaceBounds, x: surfaceBounds.x + host.x - surfaceWindowOrigin.x, y: surfaceBounds.y + host.y - surfaceWindowOrigin.y };
}
function hostBounds(capsule) {
  // Reserva ambos sentidos antes de mostrar: nunca cambia el origen al abrir, cerrar o invertir.
  const area = screen.getDisplayMatching(capsule).workArea;
  const width = Math.max(capsule.width, Math.min(778, area.width));
  const height = Math.max(capsule.height, Math.min(462, area.height));
  const x = Math.max(area.x, Math.min(capsule.x - 286, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(capsule.y - 134, area.y + area.height - height));
  return { x: Math.min(capsule.x, Math.max(capsule.x + capsule.width - width, x)), y: Math.min(capsule.y, Math.max(capsule.y + capsule.height - height, y)), width, height };
}
function surfaceEdges(bounds, origin) {
  const point = screen.dipToScreenPoint({ x: bounds.x + 28, y: bounds.y + 20 });
  const end = screen.dipToScreenPoint({ x: bounds.x + bounds.width - 28, y: bounds.y + bounds.height - 36 });
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  return { x, y, right: end.x - origin.x, bottom: end.y - origin.y };
}
function cancelMotion() {
  activeMotion?.resolve();
  activeMotion = null;
}
function describeMotion(from, to, duration) {
  const host = mainWindow.getContentBounds();
  const origin = screen.dipToScreenPoint({ x: host.x, y: host.y });
  const scale = screen.getDisplayMatching(to).scaleFactor;
  const start = surfacePixels && surfaceScale === scale ? { x: surfacePixels.x, y: surfacePixels.y, right: surfacePixels.x + surfacePixels.width, bottom: surfacePixels.y + surfacePixels.height } : surfaceEdges(from, origin);
  return { id: boundsAnimation, from: start, to: surfaceEdges(to, origin), scale, duration, radius: panelLayout.expanded ? 22 : 21 };
}
function animateBounds(from, to, duration) {
  cancelMotion();
  ++boundsAnimation;
  const host = mainWindow.getContentBounds();
  const origin = screen.dipToScreenPoint({ x: host.x, y: host.y });
  const motion = describeMotion(from, to, duration);
  surfacePixels = motionRect(motion, duration ? 0 : 1);
  surfaceScale = motion.scale;
  surfaceBounds = duration ? from : to;
  surfaceWindowOrigin = host;
  glassMorph = panelLayout.expanded ? 1 : 0;
  syncGlassSafely();
  if (duration) {
    boundsMotion = new Promise(resolve => { activeMotion = { ...motion, origin, target: to, progress: -1, resolve }; });
  } else boundsMotion = Promise.resolve();
  return motion;
}
function paintMotion(id, progress, complete) {
  if (!Number.isInteger(id) || !Number.isFinite(progress) || progress < 0 || progress > 1 || typeof complete !== 'boolean' || (complete && progress !== 1)) throw new Error('Frame inválido');
  const motion = activeMotion;
  if (!motion || motion.id !== id || progress < motion.progress) return;
  const rect = motionRect(motion, progress);
  surfacePixels = rect;
  const host = mainWindow.getContentBounds();
  surfaceBounds = { x: host.x + rect.x / motion.scale - 28, y: host.y + rect.y / motion.scale - 20, width: rect.width / motion.scale + 56, height: rect.height / motion.scale + 56 };
  surfaceWindowOrigin = host;
  if (progress !== motion.progress) {
    try { glassPanel.setBounds({ ...rect, x: motion.origin.x + rect.x, y: motion.origin.y + rect.y }); }
    catch (error) { console.error('No se pudo actualizar Liquid Glass:', error); }
  }
  motion.progress = progress;
  if (complete) {
    surfaceBounds = motion.target;
    layoutTarget = null;
    cancelMotion();
  }
}

async function readSettings() { try { return JSON.parse(await readFile(settingsPath(), 'utf8')); } catch { return {}; } }
function writePosition() {
  clearTimeout(saveTimer);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = layoutTarget || getSurfaceBounds();
  const target = settingsPath();
  const temporary = `${target}.${process.pid}.tmp`;
  const current = layoutSize();
  const collapsed = layoutSize({ ...panelLayout, expanded: false, selectorOpen: false });
  const capsule = initialPosition || (panelLayout.expanded ? placeBounds(bounds, current, collapsed, layoutPlacement) : bounds);
  // El cierre de Electron no espera promesas de escritura.
  try { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(temporary, JSON.stringify({ x: capsule.x, y: capsule.y })); renameSync(temporary, target); }
  catch { /* no impide cerrar */ }
  finally { try { rmSync(temporary, { force: true }); } catch { /* no impide cerrar */ } }
}
function schedulePositionSave() { clearTimeout(saveTimer); saveTimer = setTimeout(writePosition, 400); }
function harden(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}
function updateGlassContrast(bands) {
  // Las bandas ya describen el destino; descarta muestras parciales mientras cambia la superficie.
  if (!mainWindow || mainWindow.isDestroyed() || activeMotion) return;
  const contrast = { ...glassLightText };
  for (const [id, key] of glassBandKeys.entries()) {
    if (!bands[id]) continue;
    const { r, g, b } = bands[id];
    const luma = .2126 * r + .7152 * g + .0722 * b;
    // La separación entre umbrales evita parpadeos al moverlo sobre tonos medios.
    contrast[key] = luma < (glassLightText[key] ? 145 : 115);
  }
  if (Object.keys(contrast).every(key => contrast[key] === glassLightText[key])) return;
  glassLightText = contrast;
  mainWindow.webContents.send('monitor:glass', contrast);
}
function syncGlass() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = getSurfaceBounds();
  const { scaleFactor } = screen.getDisplayMatching(bounds);
  const edges = surfaceEdges(bounds, { x: 0, y: 0 });
  const host = mainWindow.getContentBounds();
  const origin = screen.dipToScreenPoint({ x: host.x, y: host.y });
  const rect = surfacePixels && surfaceScale === scaleFactor ? { ...surfacePixels, x: origin.x + surfacePixels.x, y: origin.y + surfacePixels.y } : { x: edges.x, y: edges.y, width: edges.right - edges.x, height: edges.bottom - edges.y };
  const effect = {
    cornerRadius: (21 + glassMorph) * scaleFactor,
    blurSigma: (4.5 + 1.5 * glassMorph) * scaleFactor,
    displacementScale: (54 + 16 * glassMorph) * scaleFactor,
    aberrationIntensity: 1.4 + .6 * glassMorph,
    saturation: 1.28 + .12 * glassMorph,
  };
  if (glassPanel && glassScale !== scaleFactor) { glassPanel.destroy(); glassPanel = null; }
  if (!glassPanel) {
    glassScale = scaleFactor;
    glassPanel = glass.createPanel({ ...rect, ...effect, dpr: scaleFactor, capturePolicy: glassCapturePolicy, anchorWindow: mainWindow, onLuma: updateGlassContrast });
    if (!glassPanel) throw new Error('No se pudo crear el panel nativo Liquid Glass.');
  } else {
    glassPanel.setBounds(rect);
    glassPanel.setParams(effect);
  }
  const target = layoutTarget || bounds;
  const bandRect = { width: Math.round((target.width - 56) * scaleFactor), height: Math.round((target.height - 56) * scaleFactor) };
  if (panelLayout.expanded) {
    if (!panelLayout.providers.length) {
      glassBandKeys = ['footer'];
      glassPanel.setLumaBands([{ id: 0, x: 0, y: 0, ...bandRect }]);
      if (mainWindow.isVisible()) glassPanel.show(0);
      return;
    }
    const footerY = Math.min(bandRect.height, Math.round(158 * scaleFactor));
    const columns = panelLayout.providers.length;
    glassBandKeys = [...panelLayout.providers, 'footer'];
    const providerBands = panelLayout.providers.map((key, id) => {
      const x = Math.round(id * bandRect.width / columns);
      const right = Math.round((id + 1) * bandRect.width / columns);
      return { id, x, y: 0, width: right - x, height: footerY };
    });
    glassPanel.setLumaBands([...providerBands, { id: providerBands.length, x: 0, y: footerY, width: bandRect.width, height: bandRect.height - footerY }]);
  } else {
    const keys = panelLayout.providers.length ? panelLayout.providers : ['footer'];
    glassBandKeys = keys;
    glassPanel.setLumaBands(keys.map((_key, id) => {
      const y = Math.round(id * bandRect.height / keys.length);
      const bottom = Math.round((id + 1) * bandRect.height / keys.length);
      return { id, x: 0, y, width: bandRect.width, height: bottom - y };
    }));
  }
  if (mainWindow.isVisible()) glassPanel.show(0);
}
function syncGlassSafely(show = false) {
  if (positioningHost) return;
  try {
    if (activeMotion) {
      if (show === true && glassHidden) { glassPanel?.show(0); glassHidden = false; }
      return;
    }
    syncGlass();
    if (mainWindow?.isVisible()) glassHidden = false;
  }
  catch (error) { console.error('No se pudo actualizar Liquid Glass:', error); }
}
async function createWindow() {
  if (!glass.isSupported()) throw new Error('Liquid Glass requiere Windows 10 2004 o posterior y su módulo nativo para Windows x64.');
  const saved = await readSettings();
  const installed = detectedProviders().filter(provider => provider.installed).map(provider => provider.key);
  panelLayout = { expanded: false, selectorOpen: false, providers: installed };
  const size = layoutSize();
  nativeTheme.themeSource = 'light';
  const primary = screen.getPrimaryDisplay().workArea;
  initialPosition = { x: Number.isFinite(saved.x) ? Math.round(saved.x) : primary.x + primary.width - size.width - 24, y: Number.isFinite(saved.y) ? Math.round(saved.y) : primary.y + 80 };
  const area = screen.getDisplayMatching({ ...initialPosition, ...size }).workArea;
  const x = Math.max(area.x, Math.min(initialPosition.x, area.x + area.width - size.width));
  const y = Math.max(area.y, Math.min(initialPosition.y, area.y + area.height - size.height));
  surfaceBounds = { x, y, ...size };
  surfacePixels = null;
  const host = hostBounds(surfaceBounds);
  mainWindow = new BrowserWindow({ ...host, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false, show: false, webPreferences: { preload: path.join(dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, spellcheck: false } });
  surfaceWindowOrigin = mainWindow.getBounds();
  hostReady = true;
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  // En Windows, 'floating' (el nivel por omisión) reinserta la ventana tras la barra de tareas al
  // activarse; si una app en pantalla completa le quitó el topmost a la barra, el widget lo pierde.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  glassCapturePolicy = glass.setWindowCapturePolicy(mainWindow, 'dda-only') ? 'dda-only' : 'all';
  harden(mainWindow.webContents);
  syncGlass();
  mainWindow.on('move', syncGlassSafely);
  mainWindow.on('resize', syncGlassSafely);
  mainWindow.on('show', () => syncGlassSafely(true));
  mainWindow.on('hide', () => { glassPanel?.hide(0); glassHidden = true; });
  mainWindow.on('moved', schedulePositionSave);
  mainWindow.on('close', event => {
    writePosition();
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { cancelMotion(); glassPanel?.destroy(); glassPanel = null; mainWindow = null; surfaceBounds = null; hostReady = false; });
  mainWindow.webContents.on('did-finish-load', () => { if (!initialPosition) applyLayout({ expanded: false, selectorOpen: false, reduceMotion: true, providers: panelLayout.providers }); mainWindow.webContents.send('monitor:glass', glassLightText); });
  await mainWindow.loadFile(path.join(dirname, '..', 'renderer', 'index.html'));
  mainWindow.show();
}
async function update(key, read) {
  try {
    const value = await read();
    limitsCache[key] = { value, fetchedAt: value.fetchedAt, error: null };
    return true;
  } catch (error) {
    limitsCache[key] = { ...limitsCache[key], error: error?.message || 'Sin datos' };
    return false;
  }
}
async function dashboard(force = false) {
  if (force) await readClaude();
  const now = Date.now();
  return { limits: { claude: projectClaude(limitsCache.claude, now), codex: projectCodex(limitsCache.codex, now) }, providers: detectedProviders() };
}
// fetchedAt cambia en cada lectura; sin él, la firma solo cambia cuando cambia lo que se ve.
const signature = data => JSON.stringify(data, (key, value) => key === 'fetchedAt' ? undefined : value);
let lastPublished = '';
async function publish() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const data = await dashboard();
  const current = signature(data);
  if (current === lastPublished || !mainWindow || mainWindow.isDestroyed()) return;
  lastPublished = current;
  mainWindow.webContents.send('monitor:update', data);
}
function readClaude() {
  return claudeRead ||= update('claude', () => claude.read()).then(publish).finally(() => { claudeRead = null; });
}
async function pollClaude() {
  clearTimeout(claudeTimer);
  await readClaude();
  claudeTimer = setTimeout(() => void pollClaude(), CLAUDE_POLL_MS);
}
// Lecturas solapadas comparten la que está en curso.
function readCodex() {
  return codexRead ||= update('codex', () => codex.read()).then(async ok => { await publish(); return ok; }).finally(() => { codexRead = null; });
}
// Solo se observa que una sesión de Codex cambió, nunca su contenido; la primera escritura de un
// turno programa una lectura y las demás se absorben hasta que ocurra.
function watchCodex() {
  if (codexWatcher) return;
  const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  try { codexWatcher = watch(sessions, { recursive: true }, () => { codexKick ||= setTimeout(() => { codexKick = null; void readCodex(); }, CODEX_KICK_MS); }); }
  catch { return; }
  codexWatcher.on('error', () => { codexWatcher.close(); codexWatcher = null; });
}
async function pollCodex() {
  clearTimeout(codexTimer);
  watchCodex();
  const ok = await readCodex();
  codexTimer = setTimeout(() => void pollCodex(), ok ? CODEX_POLL_MS : CODEX_RETRY_MS);
}
// Arranca con Windows. Se registra solo si falta para no reactivarlo si el usuario lo desactivó en
// el Administrador de tareas; el portable se registra por su exe real, no por la copia temporal.
function startAtLogin() {
  if (!app.isPackaged) return;
  const login = { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath };
  if (!app.getLoginItemSettings(login).openAtLogin) app.setLoginItemSettings({ ...login, openAtLogin: true });
}
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}
function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('Agent Usage Monitor');
  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar Agent Usage Monitor', click: showWindow },
    { type: 'separator' },
    { label: 'Cerrar Agent Usage Monitor', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => tray.popUpContextMenu(menu));
}
function fromWidget(event) { return Boolean(mainWindow) && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame?.url?.startsWith('file://'); }
function handle(channel, listener) { ipcMain.handle(channel, (event, ...args) => { if (!fromWidget(event)) throw new Error('IPC no autorizado'); return listener(...args); }); }
handle('monitor:read', force => dashboard(force === true));
handle('monitor:open-install', key => {
  const provider = PROVIDERS.find(item => item.key === key);
  if (!provider) throw new Error('Proveedor inválido');
  return shell.openExternal(provider.installUrl);
});
function applyLayout(layout) {
  if (!layout || typeof layout.expanded !== 'boolean' || typeof layout.selectorOpen !== 'boolean' || typeof layout.reduceMotion !== 'boolean') throw new Error('Estado de panel inválido');
  const next = { expanded: layout.expanded, selectorOpen: layout.selectorOpen, providers: normalizeProviderKeys(layout.providers) };
  if (!next.expanded && next.selectorOpen) throw new Error('Estado de selector inválido');
  const bounds = getSurfaceBounds();
  const anchor = initialPosition ? { ...bounds, ...initialPosition } : layoutTarget || bounds;
  const size = layoutSize(next);
  const previous = layoutSize(panelLayout);
  const area = screen.getDisplayMatching(initialPosition ? { ...initialPosition, ...size } : bounds).workArea;
  if (!panelLayout.expanded) layoutPlacement = placementFor(anchor, area);
  const unchanged = next.expanded === panelLayout.expanded && next.selectorOpen === panelLayout.selectorOpen && next.providers.join() === panelLayout.providers.join();
  if (unchanged && !initialPosition && hostReady && !(activeMotion && layout.reduceMotion)) return { placement: layoutPlacement, duration: 0, delay: 0, motion: activeMotion ? undefined : describeMotion(bounds, bounds, 0) };
  // La primera visibilidad llega de localStorage: cambia el tamaño sin desplazar la cápsula.
  const placed = initialPosition ? { ...initialPosition, ...size } : placeBounds(anchor, previous, size, layoutPlacement);
  placed.x = Math.max(area.x, Math.min(placed.x, area.x + area.width - size.width));
  placed.y = Math.max(area.y, Math.min(placed.y, area.y + area.height - size.height));
  const directionChanged = panelLayout.expanded !== next.expanded;
  const duration = initialPosition || layout.reduceMotion ? 0 : directionChanged ? MOTION_MS.toggle : MOTION_MS.resize;
  panelLayout = next;
  initialPosition = null;
  layoutTarget = placed;
  if (!hostReady) {
    mainWindow.setBounds(hostBounds(bounds));
    surfaceBounds = bounds;
    surfaceWindowOrigin = mainWindow.getBounds();
    hostReady = true;
  }
  const motion = animateBounds(bounds, placed, duration);
  if (!duration) layoutTarget = null;
  return { placement: layoutPlacement, duration, delay: 0, motion };
}
handle('monitor:layout', applyLayout);
ipcMain.on('monitor:frame', (event, id, progress, complete) => {
  if (!fromWidget(event)) return;
  try { paintMotion(id, progress, complete); }
  catch (error) { console.error('Frame de widget rechazado:', error.message); }
});
handle('monitor:hit-test', interactive => {
  if (typeof interactive !== 'boolean') throw new Error('Área de puntero inválida');
  mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});
handle('monitor:motion', async () => {
  let motion;
  do { motion = boundsMotion; await motion; } while (motion !== boundsMotion);
});
handle('monitor:move', (x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Posición inválida');
  cancelMotion();
  ++boundsAnimation;
  initialPosition = null;
  layoutTarget = null;
  glassMorph = panelLayout.expanded ? 1 : 0;
  const target = { x: Math.round(x), y: Math.round(y), ...layoutSize() };
  positioningHost = true;
  try { mainWindow.setBounds(hostBounds(target)); }
  finally { positioningHost = false; }
  surfacePixels = null;
  const motion = animateBounds(target, target, 0);
  mainWindow.webContents.send('monitor:surface', motion);
  schedulePositionSave();
  if (panelLayout.expanded) {
    const bounds = getSurfaceBounds();
    layoutPlacement = placementFor(bounds, screen.getDisplayMatching(bounds).workArea);
  }
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.on('web-contents-created', (_event, contents) => harden(contents));
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(() => { startAtLogin(); createTray(); void pollClaude(); void pollCodex(); return createWindow(); }).catch(error => { dialog.showErrorBox('Agent Usage Monitor', error.message); app.quit(); });
  app.on('will-quit', () => { clearTimeout(claudeTimer); clearTimeout(codexTimer); clearTimeout(codexKick); codexWatcher?.close(); claude.close(); codex.close(); glass.shutdown(); });
}
