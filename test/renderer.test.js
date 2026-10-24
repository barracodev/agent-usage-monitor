import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { formatReset } from '../src/core/limits.js';
import { activeResetAt, formatAge, formatCountdown, meterTone, providerState } from '../src/core/presentation.js';
import { createClock, flush } from './helpers/clock.js';

async function settingsHarness() {
  const source = (await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
  const clock = createClock();
  const elements = {};
  for (const selector of ['#providers', '.widget', '#toggle', '#footer', '#footer-status', '#settings', '#settings-menu', '#provider-settings', '#empty-state', '#empty-icon']) {
    const classes = new Set();
    elements[selector] = { dataset: {}, children: [], hidden: true, innerHTML: '', attributes: {}, listeners: {}, classes,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; }, contains: () => false,
    };
  }
  let finishMotion;
  let motion = Promise.resolve();
  const context = vm.createContext({ formatReset, activeResetAt, formatAge, formatCountdown, meterTone, providerState,
    document: { querySelector: selector => elements[selector], addEventListener() {} },
    localStorage: { getItem: () => null },
    window: { matchMedia: () => ({ matches: false }), usageMonitor: {
      read: async () => ({ limits: {}, providers: [{ key: 'claude', name: 'Claude', installed: true }, { key: 'codex', name: 'Codex', installed: true }] }),
      layout: async () => ({ placement: { horizontal: 'right', vertical: 'down' }, duration: 160, delay: 24 }),
      waitForMotion: () => motion, onUpdate() {}, onGlass() {},
    } },
    ...clock, setInterval() {}, requestAnimationFrame: fn => clock.setTimeout(fn, 16),
  });
  vm.runInContext(source, context);
  await flush();
  const call = expression => vm.runInContext(expression, context);
  const initial = call('setExpanded(true)');
  await clock.advance(1000);
  await initial;
  return { elements, clock, call, holdMotion() { motion = new Promise(resolve => { finishMotion = resolve; }); }, finishMotion: () => finishMotion() };
}

for (const close of ['closeSettings()', 'setExpanded(false)']) {
  test(`cancelar una apertura con ${close} mantiene el menú oculto`, async () => {
    const h = await settingsHarness();
    h.holdMotion();
    const opening = h.call('openSettings()');
    await flush();
    const closing = h.call(close);
    await h.clock.advance(1000);
    h.finishMotion();
    await Promise.all([opening, closing]);
    assert.equal(h.elements['#settings-menu'].hidden, true);
    assert.equal(h.elements['#settings-menu'].classes.has('open'), false);
    assert.equal(h.elements['#settings'].attributes['aria-expanded'], 'false');
    assert.equal(h.call('settingsOpen'), false);
  });
}

test('el renderer espera la confirmación de la ventana antes de mostrar ajustes', async () => {
  const h = await settingsHarness();
  h.holdMotion();
  const opening = h.call('openSettings()');
  await h.clock.advance(1000);
  assert.equal(h.elements['#settings-menu'].hidden, true, 'el tiempo estimado no sustituye el fin real de la animación');
  h.finishMotion();
  await opening;
  await h.clock.advance(16);
  assert.equal(h.elements['#settings-menu'].hidden, false);
  assert.equal(h.elements['#settings-menu'].classes.has('open'), true);
});

test('cerrar ajustes antes del siguiente frame no revive su clase open', async () => {
  const h = await settingsHarness();
  h.call('window.usageMonitor.layout = async () => ({ duration: 0 })');
  const opening = h.call('openSettings()');
  await flush();
  await opening;
  const closing = h.call('closeSettings()');
  await h.clock.advance(1000);
  await closing;
  assert.equal(h.elements['#settings-menu'].hidden, true);
  assert.equal(h.elements['#settings-menu'].classes.has('open'), false);
});

test('contraer el panel impide reabrir ajustes durante su cierre', async () => {
  const h = await settingsHarness();
  await h.call('openSettings()');
  await h.clock.advance(16);
  const closing = h.call('setExpanded(false)');
  await h.clock.advance(50);
  await h.call('openSettings()');
  await h.clock.advance(1000);
  await closing;
  assert.equal(h.call('settingsOpen'), false);
  assert.equal(h.elements['#settings-menu'].hidden, true);
  assert.equal(h.elements['.widget'].classes.has('expanded'), false);
});

test('el renderer conserva opening hasta que la ventana termina', async () => {
  const h = await settingsHarness();
  const closing = h.call('setExpanded(false)');
  await h.clock.advance(1000);
  await closing;
  h.holdMotion();
  const opening = h.call('setExpanded(true)');
  await h.clock.advance(1000);
  assert.equal(h.elements['.widget'].classes.has('opening'), true);
  h.finishMotion();
  await opening;
  assert.equal(h.elements['.widget'].classes.has('opening'), false);
});

test('renderer refresh, minute tick, failure and opt-in use the minimal surface', async () => {
  const source = (await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
  const listeners = {};
  const intervals = [];
  const fills = [{ style: {} }, { style: {} }];
  const bars = [{ style: {} }, { style: {} }];
  const children = ['claude', 'codex'].map((key, index) => ({ dataset: { provider: key }, querySelector: selector => selector === '.fill' ? fills[index] : bars[index] }));
  const providers = { innerHTML: '', children, dataset: {}, hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const toggleListeners = {};
  const attributes = {};
  const classes = new Set();
  const toggle = { addEventListener: (name, fn) => { toggleListeners[name] = fn; }, setAttribute: (name, value) => { attributes[name] = value; }, setPointerCapture() {}, releasePointerCapture() {} };
  const widget = { dataset: {}, classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), add: name => classes.add(name), remove: name => classes.delete(name) } };
  const footerClasses = new Set();
  const footer = { innerHTML: '', classList: { toggle: (name, enabled) => enabled ? footerClasses.add(name) : footerClasses.delete(name) } };
  const footerStatus = { innerHTML: '', setAttribute() {}, classList: { toggle() {} } };
  const settingsListeners = {};
  const settingsButton = { innerHTML: '', addEventListener: (name, fn) => { settingsListeners[`button:${name}`] = fn; }, setAttribute() {}, contains: () => false };
  const menuClasses = new Set();
  const settingsMenu = { hidden: true, contains: () => false, classList: { toggle: (name, enabled) => enabled ? menuClasses.add(name) : menuClasses.delete(name), add: name => menuClasses.add(name), remove: name => menuClasses.delete(name) } };
  const providerSettings = { innerHTML: '', addEventListener: (name, fn) => { settingsListeners[`list:${name}`] = fn; } };
  const emptyState = { hidden: true };
  const emptyIcon = { innerHTML: '' };
  const layouts = [];
  const lastLayout = () => JSON.parse(JSON.stringify(layouts.at(-1)));
  const moves = [];
  let data = { limits: { claude: { value: { usedPercent: 80, resetsAt: Date.now() + 600000 }, fetchedAt: Date.now() }, codex: { value: { usedPercent: 100, resetsAt: Date.now() + 600000 }, fetchedAt: Date.now() } }, providers: [{ key: 'claude', name: 'Claude', installed: true }, { key: 'codex', name: 'Codex', installed: true }] };
  let failed = false;
  const installPages = [];
  const stored = {};
  let push;
  let glass;
  let animationFrame;
  const context = vm.createContext({ formatReset, activeResetAt, formatAge, formatCountdown, meterTone, providerState,
    document: { querySelector: selector => ({ '#providers': providers, '#toggle': toggle, '.widget': widget, '#footer': footer, '#footer-status': footerStatus, '#settings': settingsButton, '#settings-menu': settingsMenu, '#provider-settings': providerSettings, '#empty-state': emptyState, '#empty-icon': emptyIcon })[selector] || { addEventListener() {} }, addEventListener: (name, fn) => { settingsListeners[`document:${name}`] = fn; } },
    localStorage: { getItem: key => stored[key] || null, setItem: (key, value) => { stored[key] = value; } },
    window: { screenX: 100, screenY: 200, matchMedia: () => ({ matches: false }), usageMonitor: { layout: value => { layouts.push(value); return Promise.resolve({ horizontal: 'right', vertical: 'down' }); }, waitForMotion: async () => {}, move: (x, y) => moves.push([x, y]), read: async () => { if (failed) throw Error(); return data; }, openInstall: async key => { installPages.push(key); }, onUpdate: listener => { push = listener; }, onGlass: listener => { glass = listener; } } },
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    setTimeout: fn => { fn(); return 1; },
    requestAnimationFrame: fn => { animationFrame = fn; return 1; },
    cancelAnimationFrame: () => { animationFrame = null; },
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((providers.innerHTML.match(/<article/g) || []).length, 2);
  assert.equal(widget.dataset.count, '2');
  assert.deepEqual([widget.dataset.openHorizontal, widget.dataset.openVertical], ['right', 'down']);
  assert.deepEqual(lastLayout(), { expanded: false, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] });
  assert.match(settingsButton.innerHTML, /class="ui-icon icon-settings"/);
  assert.match(footerStatus.innerHTML, /class="ui-icon icon-refresh-cw"/);
  assert.doesNotMatch(footerStatus.innerHTML, /Actualizado/);
  assert.deepEqual(fills.map(fill => fill.style.strokeDasharray), ['80 100', '100 100']);
  assert.match(providers.innerHTML, /icons\/claude\.svg/);
  assert.match(providers.innerHTML, /icons\/codex\.png/);
  assert.ok(providers.innerHTML.indexOf('data-provider="claude"') < providers.innerHTML.indexOf('data-provider="codex"'));
  assert.match(providers.innerHTML, /100<span>%/);
  assert.match(providers.innerHTML, /live warn/);
  assert.match(providers.innerHTML, /Sin cuota/);
  assert.match(providers.innerHTML, /Reset \d{1,2}:\d\d[ap]m/);
  assert.doesNotMatch(providers.innerHTML, /class="dot"/);
  glass({ claude: true, codex: false, footer: true });
  assert.equal(classes.has('glass'), true);
  assert.match(providers.innerHTML, /provider live warn light-text/);
  assert.doesNotMatch(providers.innerHTML, /provider live danger light-text/);
  assert.equal(footerClasses.has('light-text'), true);
  glass({ claude: false, codex: true, footer: false });
  assert.doesNotMatch(providers.innerHTML, /provider live warn light-text/);
  assert.match(providers.innerHTML, /provider live danger light-text/);
  assert.equal(footerClasses.has('light-text'), false);
  assert.equal(typeof toggleListeners.click, 'function', 'the capsule must open its detail panel on click');
  toggleListeners.click({ detail: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(classes.has('expanded'), true);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.deepEqual(lastLayout(), { expanded: true, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] });
  assert.match(providers.innerHTML, /AGOTADO/);
  assert.deepEqual(bars.map(bar => bar.style.height), ['80%', '100%']);
  toggleListeners.pointerdown({ button: 0, pointerId: 1, screenX: 150, screenY: 250 });
  toggleListeners.pointermove({ pointerId: 1, screenX: 170, screenY: 280 });
  toggleListeners.pointerup({ pointerId: 1 });
  toggleListeners.click({ detail: 1 });
  assert.deepEqual(moves, [[120, 230]]);
  assert.equal(classes.has('expanded'), true, 'dragging must not collapse the panel');
  toggleListeners.keydown({ key: 'Escape' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(classes.has('expanded'), false);
  assert.equal(attributes['aria-expanded'], 'false');
  toggleListeners.click({ detail: 0 });
  await new Promise(resolve => setImmediate(resolve));
  await settingsListeners['button:click']({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settingsMenu.hidden, false);
  assert.equal(classes.has('selector-open'), true);
  assert.deepEqual(lastLayout(), { expanded: true, selectorOpen: true, reduceMotion: false, providers: ['claude', 'codex'] });
  assert.match(providerSettings.innerHTML, /Claude/);
  assert.match(providerSettings.innerHTML, /Codex/);
  assert.match(providerSettings.innerHTML, /aria-checked="true"/);
  assert.doesNotMatch(providerSettings.innerHTML, /role="option"/);
  assert.match(providerSettings.innerHTML, /role="group" aria-label="Claude"/);
  assert.match(providerSettings.innerHTML, /class="ui-icon icon-eye"/);
  settingsListeners['list:click']({ target: { dataset: { action: 'toggle-provider', provider: 'codex' } } });
  assert.equal((providers.innerHTML.match(/<article/g) || []).length, 1);
  assert.equal(widget.dataset.count, '1');
  assert.deepEqual(lastLayout(), { expanded: true, selectorOpen: true, reduceMotion: false, providers: ['claude'] });
  assert.deepEqual(JSON.parse(stored['usage-monitor:providers']), { codex: false });
  settingsListeners['list:click']({ target: { dataset: { action: 'toggle-provider', provider: 'claude' } } });
  assert.equal(widget.dataset.count, '0');
  assert.equal(providers.hidden, true);
  assert.equal(emptyState.hidden, false);
  assert.deepEqual(lastLayout(), { expanded: true, selectorOpen: true, reduceMotion: false, providers: [] });
  settingsListeners['list:click']({ target: { dataset: { action: 'toggle-provider', provider: 'claude' } } });
  settingsListeners['list:click']({ target: { dataset: { action: 'toggle-provider', provider: 'codex' } } });
  await settingsListeners['button:click']({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settingsMenu.hidden, true);
  assert.equal(classes.has('selector-open'), false);
  assert.deepEqual(lastLayout(), { expanded: true, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] });
  data.limits.claude.value.resetsAt = Date.now() - 1;
  intervals.find(item => item.ms === 60000).fn();
  assert.doesNotMatch(providers.innerHTML, /0 h 0 m/);
  assert.match(providers.innerHTML, /data-provider="claude" title="Claude · Esperando actualización · Reset —"/);
  failed = true;
  await vm.runInContext('refresh()', context);
  assert.doesNotMatch(providers.innerHTML, /live|Sin cuota|<span>%/);
  assert.match(providers.innerHTML, /Stale/);
  assert.deepEqual(fills.map(fill => fill.style.strokeDasharray), ['0 100', '0 100']);
  failed = false;
  data.limits = { claude: { value: null }, codex: { value: { usedPercent: 0 } } };
  await vm.runInContext('refresh()', context);
  assert.match(providers.innerHTML, /Sin datos/);
  assert.match(providers.innerHTML, /0<span>%/);
  assert.match(providers.innerHTML, /DISPONIBLE/);
  assert.doesNotMatch(providers.innerHTML, /Reset \d/);
  push({ limits: { claude: { value: { usedPercent: 12, resetsAt: Date.now() + 600000 } }, codex: { value: null } }, providers: data.providers });
  assert.match(providers.innerHTML, /12<span>%/);
  push({ limits: { claude: { value: { usedPercent: 64, resetsAt: Date.now() + 600000 }, aged: true, fetchedAt: Date.now() - 42 * 60000 }, codex: { value: null } }, providers: data.providers });
  assert.match(providers.innerHTML, /provider aged good/);
  assert.match(providers.innerHTML, /64<span>%/);
  assert.deepEqual(fills.map(fill => fill.style.strokeDasharray), ['64 100', '0 100']);
  assert.match(providers.innerHTML, /hace 42 min/);
  assert.match(footerStatus.innerHTML, /Claude · hace 42 min/);
  assert.match(providers.innerHTML, /class="detail-figure">64%/);
  push({ limits: data.limits, providers: [{ key: 'claude', name: 'Claude', installed: false }, { key: 'codex', name: 'Codex', installed: true }] });
  assert.match(providerSettings.innerHTML, /data-action="install" data-provider="claude"/);
  assert.match(providerSettings.innerHTML, /aria-label="Instalar Claude"/);
  settingsListeners['list:click']({ target: { dataset: { action: 'install', provider: 'claude' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(installPages, ['claude']);
});

test('la superficie elimina la X y ofrece un selector de proveedores', async () => {
  const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="quit"|aria-label="Cerrar"|>×</);
  assert.match(html, /id="settings"/);
  assert.doesNotMatch(html, /<dialog/);
  assert.match(html, /id="settings-menu"/);
  assert.match(html, /id="empty-state"/);
  assert.match(html, /id="provider-settings"/);
  assert.doesNotMatch(html, /listbox|aria-multiselectable/);
  assert.match(css, /transition: border-radius[^;]+box-shadow/);
  assert.match(css, /@keyframes content-in[^}]+blur\(3px\)/s);
});
