import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { formatReset } from '../src/core/limits.js';
import { activeResetAt, formatAge, formatCountdown, meterTone, providerState } from '../src/core/presentation.js';
import { createClock, flush } from './helpers/clock.js';
import { motionRect } from '../src/core/motion.js';

async function settingsHarness() {
  const source = (await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
  const clock = createClock();
  const elements = {};
  for (const selector of ['#providers', '.widget', '.content', '#toggle', '#window-switch', '#session', '#weekly', '#footer', '#footer-status', '#settings', '#settings-menu', '#provider-settings', '#empty-state', '#empty-icon']) {
    const classes = new Set();
    elements[selector] = { style: {}, dataset: {}, children: [], hidden: true, innerHTML: '', attributes: {}, listeners: {}, classes, clientLeft: 1, clientTop: 1, querySelector: () => null,
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; }, contains: () => false,
    };
  }
  elements['#session'].dataset.window = 'session';
  elements['#weekly'].dataset.window = 'weekly';
  let finishMotion;
  let motion = Promise.resolve();
  const context = vm.createContext({ formatReset, activeResetAt, formatAge, formatCountdown, meterTone, providerState, motionRect,
    document: { querySelector: selector => elements[selector], querySelectorAll: () => [elements['#session'], elements['#weekly']], addEventListener() {} },
    localStorage: { getItem: () => null },
    window: { matchMedia: () => ({ matches: false }), usageMonitor: {
      read: async () => ({ limits: {}, providers: [{ key: 'claude', name: 'Claude', installed: true }, { key: 'codex', name: 'Codex', installed: true }] }),
      layout: async () => ({ placement: { horizontal: 'right', vertical: 'down' }, duration: 160, delay: 24 }),
      waitForMotion: () => motion, onUpdate() {}, onGlass() {}, onSurface() {},
    } },
    ...clock, setInterval() {}, requestAnimationFrame: fn => clock.setTimeout(() => fn(clock.performance.now()), 16), cancelAnimationFrame: clock.clearTimeout,
  });
  vm.runInContext(source, context);
  await flush();
  const call = expression => vm.runInContext(expression, context);
  const initial = call('setExpanded(true)');
  await clock.advance(1000);
  await initial;
  return { elements, clock, call, context, holdMotion() { motion = new Promise(resolve => { finishMotion = resolve; }); }, finishMotion: () => finishMotion() };
}

test('el switch cambia todos los proveedores y la cápsula conserva sesión al cerrar y reabrir', async () => {
  const h = await settingsHarness();
  h.call(`latest.limits = {
    claude: { session: { value: { usedPercent: 12 } }, weekly: { value: { usedPercent: 32, resetsAt: Date.now() + 51 * 3600000 } } },
    codex: { session: { value: { usedPercent: 27 } }, weekly: { value: null } }
  }; render()`);
  assert.equal(h.elements['#session'].attributes['aria-pressed'], 'true');
  assert.match(h.elements['#providers'].innerHTML, /12<span>%/);
  const weekly = h.elements['#weekly'];
  weekly.listeners.click({ stopPropagation() {} });
  assert.equal(h.call('expanded'), true);
  assert.equal(h.call('pointer'), null);
  assert.equal(weekly.attributes['aria-pressed'], 'true');
  assert.equal(h.elements['#session'].attributes['aria-pressed'], 'false');
  assert.match(h.elements['#providers'].innerHTML, /32<span>%/);
  assert.match(h.elements['#providers'].innerHTML, /2 d 3 h/);
  assert.match(h.elements['#providers'].innerHTML, /Sin datos/);
  assert.doesNotMatch(h.elements['#providers'].innerHTML, /0<span>%|27<span>%/);
  h.call('glassContrast = { window: true, footer: false }; render()');
  assert.equal(h.elements['#window-switch'].classes.has('light-text'), true);
  assert.equal(h.elements['#footer'].classes.has('light-text'), false);
  h.holdMotion();
  const closing = h.call('setExpanded(false)');
  await h.clock.advance(1000);
  assert.equal(h.elements['#window-switch'].hidden, false, 'el switch espera el fin real del cierre');
  assert.match(h.elements['#providers'].innerHTML, /32<span>%/);
  h.call('render()');
  assert.equal(h.elements['#window-switch'].hidden, false, 'un refresco durante el cierre conserva el switch');
  assert.match(h.elements['#providers'].innerHTML, /32<span>%/);
  h.finishMotion();
  await closing;
  assert.equal(h.elements['#window-switch'].hidden, true);
  assert.match(h.elements['#providers'].innerHTML, /12<span>%/);
  assert.match(h.elements['#providers'].innerHTML, /27<span>%/);
  await h.call('setExpanded(true)');
  assert.match(h.elements['#providers'].innerHTML, /32<span>%/);
  assert.equal(h.elements['#window-switch'].hidden, false);
  const restarted = await settingsHarness();
  assert.equal(restarted.elements['#session'].attributes['aria-pressed'], 'true');
});

test('la cápsula muestra el semanal agotado vigente de cada proveedor', async () => {
  const h = await settingsHarness();
  const providers = h.elements['#providers'];
  const arcs = [{ style: {}, getBoundingClientRect() {} }, { style: {}, getBoundingClientRect() {} }];
  providers.children = ['claude', 'codex'].map((provider, index) => ({
    dataset: { provider }, querySelector: selector => selector === '.fill' ? arcs[index] : { style: {}, getBoundingClientRect() {} },
  }));
  const figures = () => [...providers.innerHTML.matchAll(/<div class="figure ">(\d+)<span>%/g)].map(match => match[1]);
  h.call(`latest.limits = {
    claude: { session: { value: { usedPercent: 3 } }, weekly: { value: { usedPercent: 100, resetsAt: Date.now() + 51 * 3600000 } } },
    codex: { session: { value: { usedPercent: 27 } }, weekly: { value: { usedPercent: 99 } } }
  }; render()`);
  assert.deepEqual(figures(), ['3', '27']);
  h.elements['#weekly'].listeners.click({ stopPropagation() {} });
  assert.deepEqual(figures(), ['100', '99']);
  assert.match(providers.innerHTML, /title="Claude: Sin cuota · /);

  await h.call('setExpanded(false)');
  assert.deepEqual(figures(), ['100', '27']);
  assert.deepEqual(arcs.map(arc => arc.style.strokeDasharray), ['100 100', '27 100']);
  assert.match(providers.innerHTML, /title="Claude: Sin cuota semanal · .* · Reset (dom|lun|mar|mié|jue|vie|sáb) /);
  assert.match(providers.innerHTML, /title="Codex · /);

  h.call(`latest.limits.claude.weekly.stale = true;
    latest.limits.codex.weekly = { value: { usedPercent: 101 }, aged: true, fetchedAt: Date.now() - 42 * 60000 };
    render()`);
  assert.deepEqual(figures(), ['3', '100']);
  assert.deepEqual(arcs.map(arc => arc.style.strokeDasharray), ['3 100', '100 100']);
  assert.match(providers.innerHTML, /title="Codex: Sin cuota semanal · hace \d+ min/);
  assert.match(providers.innerHTML, /title="Claude · /);

  h.call('delete latest.limits.codex.weekly; render()');
  assert.deepEqual(figures(), ['3', '27']);
  assert.deepEqual(arcs.map(arc => arc.style.strokeDasharray), ['3 100', '27 100']);
  assert.doesNotMatch(providers.innerHTML, /Sin cuota semanal/);
});

test('abrir y cerrar fijan el contenido en su rectángulo y lo cambian a mitad del movimiento', async () => {
  const h = await settingsHarness();
  const widget = h.elements['.widget'];
  const content = h.elements['.content'];
  const panel = { x: 28, y: 20, right: 356, bottom: 254 };
  const capsule = { x: 314, y: 20, right: 356, bottom: 158 };
  h.call(`window.usageMonitor.frame = () => {}; window.usageMonitor.layout = async () => ({ motion: pending });
    latest.limits = { claude: { session: { value: { usedPercent: 12 } }, weekly: { value: { usedPercent: 32 } } } }; selectedWindow = 'weekly'`);
  const toggle = async (expanded, from, to, id) => {
    h.context.pending = { id, from, to, scale: 1, duration: 280, radius: 21 };
    h.holdMotion();
    const done = h.call(`setExpanded(${expanded})`);
    await h.clock.advance(96);
    assert.equal(widget.classes.has('expanded'), !expanded, 'antes del cambio sigue el contenido de origen');
    assert.equal(content.style.width, `${from.right - from.x - 2}px`, 'el contenido no se reacomoda con la superficie');
    assert.equal(content.style.left, `${from.x - Number.parseFloat(widget.style.left)}px`);
    assert.ok(Number(content.style.opacity) < .1);
    await h.clock.advance(16);
    assert.equal(widget.classes.has('expanded'), expanded);
    assert.equal(content.style.width, `${to.right - to.x - 2}px`, 'el contenido nuevo nace en su tamaño final');
    assert.equal(content.style.left, `${to.x - Number.parseFloat(widget.style.left)}px`);
    if (expanded) {
      assert.equal(content.style.opacity, '1', 'al abrir, la cascada funde cada parte');
      assert.equal(widget.classes.has('entering'), true);
      assert.match(h.elements['#providers'].innerHTML, /class="provider [^"]* rise"/);
      h.call('render()');
      assert.doesNotMatch(h.elements['#providers'].innerHTML, / rise"/, 'un redibujo no repite la cascada');
    } else assert.ok(Number(content.style.opacity) > 0 && Number(content.style.opacity) < .2);
    await h.clock.advance(200);
    assert.equal(content.style.width, '', 'al llegar vuelve a ocupar la superficie');
    assert.equal(content.style.opacity, '');
    h.finishMotion();
    await done;
    await h.clock.advance(400);
    assert.equal(widget.classes.has('entering'), false);
  };
  await toggle(false, panel, capsule, 2);
  assert.match(h.elements['#providers'].innerHTML, /12<span>%/);
  assert.equal(h.elements['#window-switch'].hidden, true);
  await toggle(true, capsule, panel, 3);
  assert.match(h.elements['#providers'].innerHTML, /32<span>%/);
  assert.equal(h.elements['#window-switch'].hidden, false);
});

test('el switch desliza su indicador, anima los valores y lleva la barra desde su altura anterior', async () => {
  const h = await settingsHarness();
  const providers = h.elements['#providers'];
  const committed = [];
  const bar = { style: {}, getBoundingClientRect() { committed.push(this.style.height); } };
  providers.children = [{ dataset: { provider: 'claude' }, querySelector: selector => selector === '.bar-fill' ? bar : { style: {} } }];
  h.call(`latest.limits = { claude: { session: { value: { usedPercent: 12 } }, weekly: { value: { usedPercent: 32 } } } }; render()`);
  assert.equal(h.elements['#window-switch'].dataset.window, 'session');
  h.elements['#weekly'].listeners.click({ stopPropagation() {} });
  assert.equal(h.elements['#window-switch'].dataset.window, 'weekly');
  assert.equal(providers.dataset.shift, 'forward');
  assert.deepEqual(committed, ['12%']);
  assert.equal(bar.style.height, '32%');
  h.call('render()');
  assert.deepEqual(committed, ['12%'], 'un refresco sin cambios no vuelve a animar la barra');
  h.elements['#session'].listeners.click({ stopPropagation() {} });
  assert.equal(providers.dataset.shift, 'back');
  await h.clock.advance(400);
  assert.equal(providers.dataset.shift, undefined);
});

test('la cápsula cuenta hasta el valor nuevo, lleva el arco desde el anterior y late al cruzar 80 %', async () => {
  const h = await settingsHarness();
  const providers = h.elements['#providers'];
  const closing = h.call('setExpanded(false)');
  await h.clock.advance(10);
  await closing;
  const committed = [];
  const arc = { style: {}, getBoundingClientRect() { committed.push(this.style.strokeDasharray); } };
  const figure = { innerHTML: '' };
  providers.children = [{ dataset: { provider: 'claude' }, querySelector: selector => selector === '.fill' ? arc : { style: {} } }];
  providers.querySelector = selector => selector === '[data-provider="claude"] .figure' ? figure : null;
  h.call('latest.limits = { claude: { session: { value: { usedPercent: 70 } } } }; render()');
  assert.doesNotMatch(providers.innerHTML, /crossed/);
  h.call('latest.limits.claude.session.value.usedPercent = 85; render()');
  assert.match(providers.innerHTML, /class="provider live warn crossed/);
  assert.deepEqual(committed, ['70 100']);
  assert.equal(arc.style.strokeDasharray, '85 100');
  assert.equal(figure.innerHTML, '70<span>%</span>');
  await h.clock.advance(200);
  const middle = Number.parseInt(figure.innerHTML);
  assert.ok(middle > 70 && middle < 85, String(middle));
  await h.clock.advance(400);
  assert.equal(figure.innerHTML, '85<span>%</span>');
  h.call('render()');
  assert.doesNotMatch(providers.innerHTML, /crossed/, 'solo late al cruzar el umbral');
});

test('reabrir durante el cierre conserva la ventana semanal elegida', async () => {
  const h = await settingsHarness();
  h.call("selectedWindow = 'weekly'; latest.limits = { claude: { weekly: { value: { usedPercent: 32 } } } }; render()");
  h.holdMotion();
  const closing = h.call('setExpanded(false)');
  await flush();
  const opening = h.call('setExpanded(true)');
  await flush();
  h.finishMotion();
  await Promise.all([closing, opening]);
  assert.equal(h.elements['#window-switch'].hidden, false);
  assert.match(h.elements['#providers'].innerHTML, /32<span>%/);
  assert.equal(h.elements['.widget'].classes.has('expanded'), true);
});

test('cerrar con ajustes abiertos conserva el semanal durante la espera del menú', async () => {
  const h = await settingsHarness();
  h.call("selectedWindow = 'weekly'; latest.limits = { claude: { weekly: { value: { usedPercent: 32 } } } }; render()");
  await h.call('openSettings()');
  const closing = h.call('setExpanded(false)');
  await h.clock.advance(50);
  h.call('render()');
  assert.equal(h.elements['#window-switch'].hidden, false);
  assert.match(h.elements['#providers'].innerHTML, /32<span>%/);
  await h.clock.advance(1000);
  await closing;
  assert.equal(h.elements['#window-switch'].hidden, true);
});

test('solo el semanal de Claude en cero conserva su cuenta atrás y reinicio futuro', async () => {
  const h = await settingsHarness();
  h.call(`const zero = { value: { usedPercent: 0, resetsAt: Date.now() + 51 * 3600000 } };
    latest.limits = { claude: { session: zero, weekly: zero }, codex: { session: zero, weekly: zero } }`);
  for (const period of ['session', 'weekly']) {
    h.call(`selectedWindow = '${period}'; render()`);
    const cells = h.elements['#providers'].innerHTML.match(/<article[\s\S]*?<\/article>/g);
    for (const [index, key] of ['claude', 'codex'].entries()) {
      if (period === 'weekly' && key === 'claude') {
        assert.match(cells[index], /Reinicia en/);
        assert.match(cells[index], /2 d 3 h/);
        assert.match(cells[index], /class="reset">Reset /);
        assert.doesNotMatch(cells[index], /DISPONIBLE|Inicia al usarla/);
      } else {
        assert.match(cells[index], /DISPONIBLE/);
        assert.match(cells[index], /Inicia al usarla/);
        assert.match(cells[index], /class="reset"><\/div>/);
      }
    }
  }
});

test('el reinicio semanal lleva Reset antes del día y la hora', async () => {
  const h = await settingsHarness();
  const markup = h.call("cell('Claude', 'claude', { value: { usedPercent: 32, resetsAt: Date.now() + 51 * 3600000 } }, 'weekly')");
  assert.match(markup, /class="reset">Reset (dom|lun|mar|mié|jue|vie|sáb) \d{1,2}:\d{2}(am|pm)<\/div>/);
});

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

test('el estado vacío usa el contraste del pie tanto plegado como desplegado', async () => {
  const h = await settingsHarness();
  for (const expanded of [false, true]) {
    for (const light of [false, true]) {
      h.call(`expanded = ${expanded}; visibility = { claude: false, codex: false }; glassContrast = { claude: ${!light}, codex: ${!light}, footer: ${light} }; render()`);
      assert.equal(h.elements['#empty-state'].hidden, false);
      assert.equal(h.elements['#empty-state'].classes.has('light-text'), light);
    }
  }
});

test('refrescar datos o contraste no reemplaza los controles de ajustes', async () => {
  const h = await settingsHarness();
  await h.call('openSettings()');
  const settings = h.elements['#provider-settings'];
  let replacements = 0;
  let markup = settings.innerHTML;
  Object.defineProperty(settings, 'innerHTML', { get: () => markup, set(value) { replacements++; markup = value; } });
  await h.call('refresh()');
  h.call('render(); glassContrast = { footer: true }; render()');
  assert.equal(replacements, 0, 'los mismos botones deben conservar sus nodos entre pointerdown y pointerup');
  h.call('visibility.codex = false; render()');
  assert.equal(replacements, 1, 'cambiar visibilidad sí debe actualizar los controles');
  assert.match(settings.innerHTML, /aria-label="Mostrar Codex"/);
});

test('rAF pinta la misma geometría física enviada al cristal y descarta animaciones viejas', async () => {
  const h = await settingsHarness();
  const frames = [];
  const hits = [];
  h.call('window.usageMonitor.frame = (...args) => frameSink(...args); window.usageMonitor.hitTest = value => hitSink(value)');
  // Los sinks se instalan en el mismo contexto que el renderer.
  h.context.frameSink = (...args) => frames.push(args);
  h.context.hitSink = value => hits.push(value);
  const motion = { id: 10, from: { x: 50, y: 25, right: 103, bottom: 198 }, to: { x: 50, y: 25, right: 460, bottom: 275 }, scale: 1.25, duration: 340, radius: 22 };
  h.call(`animateSurface(${JSON.stringify(motion)})`);
  await h.clock.advance(16);
  assert.equal(frames.length, 1);
  const rect = motionRect(motion, frames[0][1]);
  assert.equal(h.elements['.widget'].style.width, `${rect.width / 1.25}px`);
  assert.equal(h.elements['.widget'].style.left, '40px');
  h.call('hitTest({ clientX: 41, clientY: 21 }); hitTest({ clientX: 41, clientY: 21 }); hitTest({ clientX: 1, clientY: 1 })');
  assert.deepEqual(hits, [true, false]);
  h.call(`animateSurface(${JSON.stringify({ ...motion, id: 11, from: motion.to, to: motion.from, duration: 0 })})`);
  const count = frames.length;
  await h.clock.advance(1000);
  assert.equal(frames.length, count, 'cancelar no envía frames del movimiento anterior');
  assert.equal(h.elements['.widget'].style.width, '42.4px');
  h.call(`animateSurface(${JSON.stringify(motion)})`);
  assert.equal(h.elements['.widget'].style.width, '42.4px', 'un mensaje atrasado no revive la animación');
});

test('renderer refresh, minute tick, failure and opt-in use the minimal surface', async () => {
  const source = (await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
  const listeners = {};
  const intervals = [];
  const fills = [{ style: {}, getBoundingClientRect() {} }, { style: {}, getBoundingClientRect() {} }];
  const bars = [{ style: {}, getBoundingClientRect() {} }, { style: {}, getBoundingClientRect() {} }];
  const children = ['claude', 'codex'].map((key, index) => ({ dataset: { provider: key }, querySelector: selector => selector === '.fill' ? fills[index] : bars[index] }));
  const providers = { innerHTML: '', children, dataset: {}, hidden: false, querySelector: () => null, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const toggleListeners = {};
  const attributes = {};
  const classes = new Set();
  const toggle = { addEventListener: (name, fn) => { toggleListeners[name] = fn; }, setAttribute: (name, value) => { attributes[name] = value; }, setPointerCapture() {}, releasePointerCapture() {} };
  const widget = { dataset: {}, classList: { contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), add: name => classes.add(name), remove: name => classes.delete(name) } };
  const footerClasses = new Set();
  const footer = { innerHTML: '', classList: { toggle: (name, enabled) => enabled ? footerClasses.add(name) : footerClasses.delete(name) } };
  const footerStatus = { innerHTML: '', setAttribute() {}, classList: { toggle() {} } };
  const settingsListeners = {};
  const settingsButton = { innerHTML: '', addEventListener: (name, fn) => { settingsListeners[`button:${name}`] = fn; }, setAttribute() {}, contains: () => false };
  const menuClasses = new Set();
  const settingsMenu = { hidden: true, contains: () => false, classList: { toggle: (name, enabled) => enabled ? menuClasses.add(name) : menuClasses.delete(name), add: name => menuClasses.add(name), remove: name => menuClasses.delete(name) } };
  const providerSettings = { innerHTML: '', addEventListener: (name, fn) => { settingsListeners[`list:${name}`] = fn; } };
  const emptyState = { hidden: true, classList: { toggle() {} } };
  const emptyIcon = { innerHTML: '' };
  const layouts = [];
  const lastLayout = () => JSON.parse(JSON.stringify(layouts.at(-1)));
  const moves = [];
  let data = { limits: { claude: { session: { value: { usedPercent: 80, resetsAt: Date.now() + 600000 }, fetchedAt: Date.now() } }, codex: { session: { value: { usedPercent: 100, resetsAt: Date.now() + 600000 }, fetchedAt: Date.now() } } }, providers: [{ key: 'claude', name: 'Claude', installed: true }, { key: 'codex', name: 'Codex', installed: true }] };
  let failed = false;
  const installPages = [];
  const stored = {};
  let push;
  let glass;
  let animationFrame;
  const context = vm.createContext({ formatReset, activeResetAt, formatAge, formatCountdown, meterTone, providerState, motionRect,
    document: { querySelector: selector => ({ '#providers': providers, '#toggle': toggle, '#window-switch': { dataset: {}, classList: { toggle() {} } }, '.widget': widget, '.content': { style: {} }, '#footer': footer, '#footer-status': footerStatus, '#settings': settingsButton, '#settings-menu': settingsMenu, '#provider-settings': providerSettings, '#empty-state': emptyState, '#empty-icon': emptyIcon })[selector] || { addEventListener() {} }, querySelectorAll: () => [], addEventListener: (name, fn) => { settingsListeners[`document:${name}`] = fn; } },
    localStorage: { getItem: key => stored[key] || null, setItem: (key, value) => { stored[key] = value; } },
    window: { screenX: 100, screenY: 200, matchMedia: () => ({ matches: false }), usageMonitor: { layout: value => { layouts.push(value); return Promise.resolve({ horizontal: 'right', vertical: 'down' }); }, waitForMotion: async () => {}, move: (x, y) => moves.push([x, y]), read: async () => { if (failed) throw Error(); return data; }, openInstall: async key => { installPages.push(key); }, onUpdate: listener => { push = listener; }, onGlass: listener => { glass = listener; }, onSurface() {} } },
    performance, setInterval: (fn, ms) => intervals.push({ fn, ms }),
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
  assert.equal(classes.has('dragging'), true, 'arrastrar levanta el widget');
  toggleListeners.pointerup({ pointerId: 1 });
  assert.equal(classes.has('dragging'), false);
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
  data.limits.claude.session.value.resetsAt = Date.now() - 1;
  intervals.find(item => item.ms === 60000).fn();
  assert.doesNotMatch(providers.innerHTML, /0 h 0 m/);
  assert.match(providers.innerHTML, /data-provider="claude" title="Claude · Esperando actualización · Reset —"/);
  failed = true;
  await vm.runInContext('refresh()', context);
  assert.doesNotMatch(providers.innerHTML, /live|Sin cuota|<span>%/);
  assert.match(providers.innerHTML, /Stale/);
  assert.deepEqual(fills.map(fill => fill.style.strokeDasharray), ['0 100', '0 100']);
  failed = false;
  data.limits = { claude: { session: { value: null } }, codex: { session: { value: { usedPercent: 0 } } } };
  await vm.runInContext('refresh()', context);
  assert.match(providers.innerHTML, /Sin datos/);
  assert.match(providers.innerHTML, /0<span>%/);
  assert.match(providers.innerHTML, /DISPONIBLE/);
  assert.doesNotMatch(providers.innerHTML, /Reset \d/);
  push({ limits: { claude: { session: { value: { usedPercent: 12, resetsAt: Date.now() + 600000 } } }, codex: { session: { value: null } } }, providers: data.providers });
  assert.match(providers.innerHTML, /12<span>%/);
  push({ limits: { claude: { session: { value: { usedPercent: 64, resetsAt: Date.now() + 600000 }, aged: true, fetchedAt: Date.now() - 42 * 60000 } }, codex: { session: { value: null } } }, providers: data.providers });
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
  assert.match(css, /transition: box-shadow/);
  // Un filtro en el fundido obliga a la GPU a prepararlo en la primera apertura y pierde un frame.
  assert.match(css, /@keyframes window-in/);
  assert.doesNotMatch(css, /@keyframes [\w-]+\s*\{[^@]*filter/);
});
