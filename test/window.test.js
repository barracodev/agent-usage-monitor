import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createClock } from './helpers/clock.js';

async function layoutHarness(bounds, clock = createClock()) {
  const source = (await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', '"file:///widget"');
  const handlers = {};
  const contents = {};
  let saved;
  const widget = {
    webContents: contents, isDestroyed: () => false, getBounds: () => ({ ...bounds }),
    setBounds: value => { bounds = value; },
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
  };
  const context = vm.createContext({
    path: { dirname: () => '', join: (...parts) => parts.join('/') }, fileURLToPath: () => '',
    createClaudeClient: () => ({}), createCodexClient: () => ({}),
    app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => '' },
    process: { pid: 1 }, mkdir: async () => {}, rename: async () => {}, writeFile: async (_target, data) => { saved = JSON.parse(data); },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    ...clock, widget,
  });
  vm.runInContext(source, context);
  vm.runInContext('mainWindow = widget', context);
  const event = { sender: contents, senderFrame: { url: 'file:///widget' } };
  return { context, widget, handlers, event, saved: () => saved,
    layout: (expanded, extra = {}) => handlers['monitor:layout'](event, { expanded, selectorOpen: false, reduceMotion: true, providers: ['claude', 'codex'], ...extra }),
  };
}

for (const [x, y] of [[900, 80], [100, 240], [100, 590]]) {
  test(`abrir y cerrar conserva la cápsula y su posición guardada en (${x}, ${y})`, async () => {
    const h = await layoutHarness({ x, y, width: 98, height: 194 });
    await h.layout(true);
    await vm.runInContext('writePosition()', h.context);
    assert.deepEqual(h.saved(), { x, y });
    await h.layout(false);
    assert.deepEqual(h.widget.getBounds(), { x, y, width: 98, height: 194 });
    assert.deepEqual(h.saved(), { x: h.widget.getBounds().x, y: h.widget.getBounds().y });
  });
}

test('la animación usa tiempo transcurrido cuando los temporizadores resuelven cada 16 ms', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 100, y: 80, width: 98, height: 194 }, clock);
  const motion = await h.layout(true, { reduceMotion: false });
  await clock.advance(128);
  assert.ok(h.widget.getBounds().width > 110, 'el avance debe seguir el reloj, no el número de callbacks');
  await clock.advance(motion.duration + motion.delay + 16 - 128);
  assert.deepEqual(h.widget.getBounds(), { x: 100, y: 80, width: 384, height: 256 });
});

test('el IPC de movimiento espera a que la ventana termine, incluso tras una pausa larga', async () => {
  const clock = createClock(320);
  const h = await layoutHarness({ x: 100, y: 80, width: 98, height: 194 }, clock);
  const motion = await h.layout(true, { reduceMotion: false });
  assert.equal(typeof h.handlers['monitor:motion'], 'function');
  let finished = false;
  const done = h.handlers['monitor:motion'](h.event).then(() => { finished = true; });
  await clock.advance(motion.duration + motion.delay + 32);
  assert.equal(finished, false, 'el plazo estimado no acredita que la ventana haya terminado');
  await clock.advance(1000);
  await done;
  assert.equal(finished, true);
  assert.equal(h.widget.getBounds().width, 384);
});

test('esperar el movimiento también espera una transición que reemplaza a la anterior', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 100, y: 80, width: 98, height: 194 }, clock);
  await h.layout(true, { reduceMotion: false });
  let finished = false;
  const done = h.handlers['monitor:motion'](h.event).then(() => { finished = true; });
  await clock.advance(64);
  await h.layout(true, { reduceMotion: false, providers: ['claude'] });
  await clock.advance(16);
  assert.equal(finished, false, 'cancelar la animación anterior no termina la nueva');
  await clock.advance(200);
  await done;
  assert.equal(finished, true);
  assert.equal(h.widget.getBounds().width, 230);
});

test('invertir una apertura en curso conserva la cápsula y guarda su destino final', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 1750, y: 840, width: 98, height: 194 }, clock);
  await h.layout(true, { reduceMotion: false });
  await clock.advance(64);
  await vm.runInContext('writePosition()', h.context);
  assert.deepEqual(h.saved(), { x: 1750, y: 840 });
  await h.layout(false, { reduceMotion: false });
  await clock.advance(300);
  assert.deepEqual(h.widget.getBounds(), { x: 1750, y: 840, width: 98, height: 194 });
});

test('widget IPC expands inside the display, collapses and rejects invalid movement', async () => {
  const source = (await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
  const handlers = {};
  const boundFrames = [];
  let now = 0;
  let saved;
  const contents = {};
  let bounds = { x: 1750, y: 840, width: 98, height: 194 };
  const widget = {
    webContents: contents, isDestroyed: () => false, getBounds: () => ({ ...bounds, width: bounds.width + 1, height: bounds.height + 1 }),
    setBounds: value => { bounds = value; boundFrames.push(value); },
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
  };
  const context = vm.createContext({
    path: { dirname: () => '', join: (...parts) => parts.join('/') }, fileURLToPath: () => '',
    createClaudeClient: () => ({}), createCodexClient: () => ({}),
    app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => '' },
    process: { pid: 1 }, mkdir: async () => {}, rename: async () => {}, writeFile: async (_target, data) => { saved = JSON.parse(data); },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } }, contents,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    performance: { now: () => now },
    setTimeout: (fn, ms) => { now += ms; fn(); return 1; },
    widget,
  });
  vm.runInContext(source.replaceAll('import.meta.url', '"file:///widget"'), context);
  vm.runInContext('mainWindow = widget', context);
  const event = { sender: contents, senderFrame: { url: 'file:///widget' } };
  assert.equal(typeof handlers['monitor:layout'], 'function', 'the real window must resize when the panel opens');
  const transition = await handlers['monitor:layout'](event, { expanded: true, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] });
  assert.deepEqual(JSON.parse(JSON.stringify(transition)), { placement: { horizontal: 'left', vertical: 'up' }, duration: 240, delay: 24 });
  assert.ok(boundFrames.length > 10, 'opening should interpolate the native window instead of jumping');
  assert.equal(bounds.width, 384);
  assert.equal(bounds.height, 256);
  assert.equal(bounds.x, 1464, 'fractional display scaling must not move the right edge on each toggle');
  assert.equal(bounds.y, 778, 'the lower third must grow upward');
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1920);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1040);
  await vm.runInContext('writePosition()', context);
  assert.equal(saved.x, 1750, 'restarting must restore the capsule position, even when closed from the expanded card');
  assert.equal(saved.y, 840, 'saving an upward card must preserve the capsule vertical position');
  const opened = { ...bounds };
  handlers['monitor:layout'](event, { expanded: true, selectorOpen: false, reduceMotion: true, providers: ['claude', 'codex'] });
  assert.deepEqual({ ...bounds }, opened, 'opening an open panel must not move it');
  handlers['monitor:layout'](event, { expanded: false, selectorOpen: false, reduceMotion: true, providers: ['claude', 'codex'] });
  assert.equal(bounds.width, 98);
  assert.equal(bounds.height, 194);
  handlers['monitor:layout'](event, { expanded: false, selectorOpen: false, reduceMotion: true, providers: ['claude'] });
  assert.deepEqual([bounds.width, bounds.height], [98, 122], 'one visible provider must shorten the capsule');
  handlers['monitor:layout'](event, { expanded: false, selectorOpen: false, reduceMotion: true, providers: [] });
  assert.deepEqual([bounds.width, bounds.height], [206, 122], 'zero providers must make room for the explicit empty state');
  handlers['monitor:layout'](event, { expanded: false, selectorOpen: false, reduceMotion: true, providers: ['claude'] });
  handlers['monitor:layout'](event, { expanded: true, selectorOpen: false, reduceMotion: true, providers: ['claude'] });
  assert.deepEqual([bounds.width, bounds.height], [230, 256], 'one visible provider must narrow the detail panel');
  handlers['monitor:layout'](event, { expanded: true, selectorOpen: true, reduceMotion: true, providers: ['claude'] });
  assert.deepEqual([bounds.width, bounds.height], [384, 256], 'the provider selector may request its minimum usable width');
  handlers['monitor:layout'](event, { expanded: false, selectorOpen: false, reduceMotion: true, providers: ['claude'] });
  assert.deepEqual([bounds.width, bounds.height], [98, 122]);
  const zones = vm.runInContext(`[
    placementFor({ x: 100, y: 50, width: 98, height: 122 }, { x: 0, y: 0, width: 1920, height: 1040 }),
    placementFor({ x: 100, y: 450, width: 98, height: 122 }, { x: 0, y: 0, width: 1920, height: 1040 }),
    placementFor({ x: 100, y: 850, width: 98, height: 122 }, { x: 0, y: 0, width: 1920, height: 1040 }),
    placementFor({ x: 1700, y: 50, width: 98, height: 122 }, { x: 0, y: 0, width: 1920, height: 1040 }),
    placementFor({ x: 1700, y: 450, width: 98, height: 122 }, { x: 0, y: 0, width: 1920, height: 1040 }),
    placementFor({ x: 1700, y: 850, width: 98, height: 122 }, { x: 0, y: 0, width: 1920, height: 1040 })
  ]`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(zones)), [
    { horizontal: 'right', vertical: 'down' }, { horizontal: 'right', vertical: 'center' }, { horizontal: 'right', vertical: 'up' },
    { horizontal: 'left', vertical: 'down' }, { horizontal: 'left', vertical: 'center' }, { horizontal: 'left', vertical: 'up' },
  ]);
  handlers['monitor:layout'](event, { expanded: true, selectorOpen: false, reduceMotion: true, providers: ['claude'] });
  handlers['monitor:move'](event, 100, 80);
  handlers['monitor:layout'](event, { expanded: false, selectorOpen: false, reduceMotion: true, providers: ['claude'] });
  assert.deepEqual([bounds.x, bounds.y], [100, 80], 'a moved open panel must close toward its current screen zone');
  handlers['monitor:move'](event, 100, 200);
  assert.equal(bounds.x, 100);
  assert.equal(bounds.y, 200);
  assert.throws(() => handlers['monitor:move'](event, NaN, 200));
  assert.throws(() => handlers['monitor:layout'](event, { expanded: 'true', selectorOpen: false, reduceMotion: true, providers: [] }));
  assert.throws(() => handlers['monitor:layout'](event, { expanded: false, selectorOpen: true, reduceMotion: true, providers: [] }));
  assert.throws(() => handlers['monitor:layout']({ sender: {} }, { expanded: true, selectorOpen: false, reduceMotion: true, providers: [] }), /IPC no autorizado/);
});

test('native glass follows the capsule, expansion and display scale, and closes with the widget', async () => {
  const source = (await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', '"file:///widget"');
  const panels = [];
  const messages = [];
  const handlers = {};
  let scaleFactor = 1.25;
  let window;
  class Widget extends EventEmitter {
    constructor(options) { super(); window = this; this.bounds = options; this.visible = false; this.webContents = Object.assign(new EventEmitter(), { send: (...args) => messages.push(args), setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }); }
    getBounds() { return this.bounds; }
    getContentBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; this.emit('resize'); this.emit('move'); }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    setAlwaysOnTop() {}
    async loadFile() { this.webContents.emit('did-finish-load'); }
    show() { this.visible = true; this.emit('show'); }
  }
  const glass = { isSupported: () => true, setWindowCapturePolicy: () => true, createPanel: options => {
    const panel = { options, bounds: options, params: options, shown: false, destroyed: false,
      setBounds(bounds) { this.bounds = bounds; }, setParams(params) { this.params = params; },
      setLumaBands(bands) { this.bands = bands; }, show() { this.shown = true; }, hide() { this.shown = false; }, destroy() { this.destroyed = true; },
    };
    panels.push(panel);
    return panel;
  } };
  const context = vm.createContext({
    path: { dirname: () => '', join: (...parts) => parts.join('/') }, fileURLToPath: () => '',
    createClaudeClient: () => ({}), createCodexClient: () => ({}), resolveExecutable: () => 'C:/bin/tool.exe', glass, BrowserWindow: Widget, nativeTheme: {},
    readFile: async () => '{"x":100,"y":200}',
    app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => '' },
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getDisplayMatching: () => ({ scaleFactor, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      dipToScreenPoint: ({ x, y }) => ({ x: Math.round(x * scaleFactor), y: Math.round(y * scaleFactor) }),
    },
  });
  vm.runInContext(source, context);
  await vm.runInContext('createWindow()', context);
  assert.equal(panels.length, 1, 'the real window must have a native glass backdrop');
  const panel = panels[0];
  assert.equal(panel.options.anchorWindow, window);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.bounds, ['x', 'y', 'width', 'height'])), { x: 160, y: 275, width: 53, height: 173 });
  assert.equal(panel.options.cornerRadius, 26.25);
  assert.equal(panel.options.blurSigma, 5.625);
  assert.equal(panel.shown, true);
  const event = { sender: window.webContents, senderFrame: { url: 'file:///widget' } };
  handlers['monitor:layout'](event, { expanded: true, selectorOpen: false, reduceMotion: true, providers: ['claude', 'codex'] });
  assert.deepEqual(JSON.parse(JSON.stringify(panel.bounds)), { x: 160, y: 275, width: 410, height: 250 });
  assert.equal(panel.params.cornerRadius, 27.5);
  assert.equal(panel.params.blurSigma, 7.5, 'native blur must reach the expanded value with the geometry');
  assert.equal(panel.bands.length, 3, 'the two provider columns and footer need separate contrast samples');
  const sample = value => ({ r: value, g: value, b: value, darkTail: value, lightTail: value });
  panel.options.onLuma({ 0: sample(10), 1: sample(240), 2: sample(240) });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), ['monitor:glass', { claude: true, codex: false, footer: false }]);
  const count = messages.length;
  panel.options.onLuma({ 0: sample(12), 1: sample(240), 2: sample(240) });
  assert.equal(messages.length, count, 'unchanged contrast must not flood IPC');
  window.webContents.emit('did-finish-load');
  assert.equal(messages.length, count + 1, 'reloading the renderer must restore glass without waiting for a background change');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), ['monitor:glass', { claude: true, codex: false, footer: false }]);
  assert.equal(window.bounds.width, 98, 'reloading must match the renderer, which starts collapsed');
  assert.equal(panel.bounds.width, 53, 'reloading must not leave expanded glass behind a collapsed capsule');
  handlers['monitor:layout'](event, { expanded: true, selectorOpen: false, reduceMotion: true, providers: ['claude', 'codex'] });
  panel.options.onLuma({ 0: sample(240), 1: sample(10), 2: sample(10) });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), ['monitor:glass', { claude: false, codex: true, footer: true }]);
  window.visible = false;
  window.emit('hide');
  assert.equal(panel.shown, false);
  scaleFactor = 2;
  window.show();
  assert.equal(panel.destroyed, true, 'changing display scale must recreate the native DPR');
  assert.equal(panels.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(panels[1].bounds, ['x', 'y', 'width', 'height'])), { x: 256, y: 440, width: 656, height: 400 });
  window.emit('closed');
  assert.equal(panels[1].destroyed, true, 'closing must not leave a native window behind');
});

test('detecta proveedores, abre solo sus instrucciones y no expone cierre por IPC', async () => {
  const source = (await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', '"file:///widget"');
  const handlers = {};
  const opened = [];
  const contents = {};
  const context = vm.createContext({
    path: { dirname: () => '', join: (...parts) => parts.join('/') }, fileURLToPath: () => '',
    createClaudeClient: () => ({}), createCodexClient: () => ({}),
    projectClaude: value => value, projectCodex: value => value,
    resolveExecutable: name => name === 'claude' ? 'C:/bin/claude.exe' : null,
    shell: { openExternal: async url => { opened.push(url); } },
    app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => '' },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } }, contents,
    process: { pid: 1 }, os: { homedir: () => 'C:/Users/test' },
  });
  vm.runInContext(source, context);
  vm.runInContext('mainWindow = { webContents: contents, isDestroyed: () => false }', context);
  const event = { sender: contents, senderFrame: { url: 'file:///widget' } };

  const dashboard = await handlers['monitor:read'](event, false);
  assert.deepEqual(Object.keys(dashboard).sort(), ['limits', 'providers']);
  assert.deepEqual(JSON.parse(JSON.stringify(dashboard.providers)), [
    { key: 'claude', name: 'Claude', installed: true },
    { key: 'codex', name: 'Codex', installed: false },
  ]);
  await handlers['monitor:open-install'](event, 'codex');
  assert.deepEqual(opened, ['https://learn.chatgpt.com/docs/codex/cli']);
  assert.throws(() => handlers['monitor:open-install'](event, 'otro'), /Proveedor inválido/);
  assert.equal(handlers['monitor:quit'], undefined);
});

test('crea una bandeja para mostrar y cerrar la app', async () => {
  const source = (await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', '"file:///widget"');
  let template;
  let quit = 0;
  let shown = 0;
  let focused = 0;
  let trayInstance;
  class FakeTray {
    constructor(icon) { this.icon = icon; trayInstance = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    popUpContextMenu(value) { this.popup = value; }
    on(name, listener) { this[name] = listener; }
  }
  const context = vm.createContext({
    path: { dirname: () => '', join: (...parts) => parts.join('/') }, fileURLToPath: () => '',
    createClaudeClient: () => ({}), createCodexClient: () => ({}),
    app: { requestSingleInstanceLock: () => false, quit: () => { quit++; }, getPath: () => '', getAppPath: () => 'C:/app' },
    ipcMain: { handle() {} }, process: { pid: 1 }, recordShow: () => { shown++; }, recordFocus: () => { focused++; },
    nativeImage: { createFromPath: value => `icon:${value}` },
    Menu: { buildFromTemplate: value => { template = value; return value; } }, Tray: FakeTray,
  });
  vm.runInContext(source, context);
  vm.runInContext('mainWindow = { isDestroyed: () => false, show: recordShow, focus: recordFocus }; createTray()', context);

  assert.equal(trayInstance.tooltip, 'Agent Usage Monitor');
  assert.match(trayInstance.icon, /assets\/icon\.ico$/);
  assert.deepEqual(JSON.parse(JSON.stringify(template.map(item => item.label || item.type))), ['Mostrar Agent Usage Monitor', 'separator', 'Cerrar Agent Usage Monitor']);
  template[0].click();
  assert.deepEqual([shown, focused], [1, 1]);
  trayInstance.click();
  assert.equal(trayInstance.popup, trayInstance.menu, 'a primary tray click must open the native Windows menu');
  const initialQuit = quit;
  template[2].click();
  assert.equal(quit, initialQuit + 1);
});
