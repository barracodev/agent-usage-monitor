import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createClock } from './helpers/clock.js';
import { MOTION_MS, motionRect } from '../src/core/motion.js';

async function layoutHarness(bounds, clock = createClock()) {
  const source = (await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', '"file:///widget"');
  const handlers = {};
  const contents = { send() {} };
  let saved;
  const widget = {
    webContents: contents, isDestroyed: () => false, getBounds: () => ({ ...bounds }), getContentBounds: () => ({ ...bounds }),
    setBounds: value => { bounds = value; },
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
  };
  const context = vm.createContext({
    path: { dirname: () => '', join: (...parts) => parts.join('/') }, fileURLToPath: () => '',
    createClaudeClient: () => ({}), createCodexClient: () => ({}),
    app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => '' },
    process: { pid: 1 }, mkdir: async () => {}, rename: async () => {}, writeFile: async (_target, data) => { saved = JSON.parse(data); },
    mkdirSync() {}, renameSync() {}, rmSync() {}, writeFileSync: (_target, data) => { saved = JSON.parse(data); },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } },
    screen: { dipToScreenPoint: point => point, getDisplayMatching: () => ({ scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    motionRect, MOTION_MS, console: { error() {} },
    ...clock, widget,
  });
  vm.runInContext(source, context);
  vm.runInContext('mainWindow = widget', context);
  const event = { sender: contents, senderFrame: { url: 'file:///widget' } };
  const h = { context, widget, handlers, event, saved: () => saved, autoPaint: true,
    bounds: () => JSON.parse(JSON.stringify(vm.runInContext('getSurfaceBounds()', context))),
    layout: (expanded, extra = {}) => {
      const result = handlers['monitor:layout'](event, { expanded, selectorOpen: false, reduceMotion: true, providers: ['claude', 'codex'], ...extra });
      if (result.motion?.duration && h.autoPaint) {
        const startedAt = clock.performance.now();
        const step = () => {
          const progress = Math.min(1, (clock.performance.now() - startedAt) / result.motion.duration);
          handlers['monitor:frame'](event, result.motion.id, progress, progress === 1);
          if (progress < 1) clock.setTimeout(step, 16);
        };
        clock.setTimeout(step, 16);
      }
      return result;
    },
  };
  return h;
}

async function startupHarness({ saved = { x: 1200, y: 500 }, files = new Map(), displays = [{ x: 0, y: 0, width: 1920, height: 1040 }], scale = 1 } = {}) {
  const source = (await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', '"file:///widget"');
  const clock = createClock();
  const handlers = {};
  let widget;
  let failPanel = false;
  let scaleFactor = scale;
  const glassCalls = [];
  let failRename = false;
  const rename = (from, to) => { if (failRename) throw new Error('rename failed'); files.set(to, files.get(from)); files.delete(from); };
  class Widget extends EventEmitter {
    constructor({ x, y, width, height }) {
      super(); widget = this; this.bounds = { x, y, width, height }; this.visible = false;
      this.webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } });
    }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return this.getBounds(); }
    setBounds(bounds) { this.bounds = { ...bounds }; this.emit('resize'); this.emit('move'); }
    setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; this.emit('move'); }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(ignore) { this.ignoresMouse = ignore; }
    async loadFile() { this.webContents.emit('did-finish-load'); }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; this.emit('hide'); }
  }
  const context = vm.createContext({
    path: { dirname: () => 'profile', join: (...parts) => parts.join('/') }, fileURLToPath: () => '',
    createClaudeClient: () => ({}), createCodexClient: () => ({}), resolveExecutable: () => 'tool.exe', BrowserWindow: Widget, nativeTheme: {},
    app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => 'profile' },
    process: { pid: 42 }, readFile: async () => files.get('profile/window.json') || JSON.stringify(saved),
    mkdir: async () => {}, writeFile: async (file, data) => files.set(file, data), rename: async (...args) => rename(...args),
    mkdirSync() {}, writeFileSync: (file, data) => files.set(file, data), renameSync: rename, rmSync: file => files.delete(file),
    glass: { isSupported: () => true, setWindowCapturePolicy: () => true, createPanel: () => failPanel ? null : Object.fromEntries(['setBounds', 'setParams', 'setLumaBands', 'show', 'hide', 'destroy'].map(name => [name, value => glassCalls.push({ name, value })])) },
    screen: {
      getPrimaryDisplay: () => ({ workArea: displays[0] }),
      getDisplayMatching: bounds => {
        const distance = area => Math.hypot(Math.max(area.x - bounds.x, 0, bounds.x - area.x - area.width), Math.max(area.y - bounds.y, 0, bounds.y - area.y - area.height));
        return { scaleFactor, workArea: [...displays].sort((a, b) => distance(a) - distance(b))[0] };
      },
      dipToScreenPoint: ({ x, y }) => ({ x: Math.round(x * scaleFactor), y: Math.round(y * scaleFactor) }),
    },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } }, motionRect, MOTION_MS, console: { error() {} }, ...clock,
  });
  vm.runInContext(source, context);
  const call = expression => vm.runInContext(expression, context);
  const invoke = (channel, ...args) => handlers[channel]({ sender: widget.webContents, senderFrame: { url: 'file:///widget' } }, ...args);
  return { context, call, files, clock, glassCalls, start: () => call('createWindow()'), window: () => widget, invoke,
    bounds: () => JSON.parse(JSON.stringify(call('getSurfaceBounds()'))),
    layout: providers => invoke('monitor:layout', { expanded: false, selectorOpen: false, reduceMotion: false, providers }),
    failGlass() { failPanel = true; scaleFactor = 2; }, failSave() { failRename = true; },
  };
}

test('el arrastre guarda sin moved y el cierre termina el guardado sin dejar temporales', async () => {
  const h = await startupHarness();
  await h.start();
  h.layout(['claude', 'codex']);
  h.invoke('monitor:move', 800, 600);
  await h.clock.advance(450);
  assert.ok(h.files.has('profile/window.json'), 'el arrastre debe guardar aunque setPosition no emita moved');
  assert.deepEqual(JSON.parse(h.files.get('profile/window.json')), { x: 800, y: 600 });
  h.invoke('monitor:move', 900, 700);
  h.call('quitting = true');
  h.window().emit('close', { preventDefault() { assert.fail('salir de bandeja debe cerrar'); } });
  assert.deepEqual(JSON.parse(h.files.get('profile/window.json')), { x: 900, y: 700 });
  assert.deepEqual([...h.files.keys()], ['profile/window.json']);
});

test('cada frame actualiza el cristal una sola vez, sin eventos redundantes y con el borde fijo a 1.25', async () => {
  const h = await startupHarness({ saved: { x: 1750, y: 840 }, scale: 1.25 });
  await h.start(); h.layout(['claude', 'codex']);
  const host = h.window().getBounds();
  const layout = expanded => h.invoke('monitor:layout', { expanded, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] });
  const opening = layout(true).motion;
  let edge;
  for (const progress of [0, .1, .25, .5, .75]) {
    h.glassCalls.length = 0;
    h.invoke('monitor:frame', opening.id, progress, false);
    for (const event of ['move', 'resize', 'show']) h.window().emit(event);
    assert.deepEqual(h.glassCalls.map(call => call.name), ['setBounds']);
    assert.deepEqual(h.window().getBounds(), host);
    const rect = h.glassCalls[0].value;
    edge ??= rect.x + rect.width;
    assert.equal(rect.x + rect.width, edge);
    const expected = motionRect(opening, progress);
    assert.equal(rect.width, expected.width);
    assert.equal(rect.x, Math.round(host.x * 1.25) + expected.x);
  }
  const last = motionRect(opening, .75);
  const closing = layout(false).motion;
  assert.deepEqual(JSON.parse(JSON.stringify(closing.from)), { x: last.x, y: last.y, right: last.x + last.width, bottom: last.y + last.height });
  h.glassCalls.length = 0;
  h.invoke('monitor:frame', opening.id, 1, true);
  assert.equal(h.glassCalls.length, 0, 'un frame anterior no termina la inversión');
  assert.throws(() => h.call(`paintMotion(${closing.id}, NaN, false)`), /Frame inválido/);
  assert.throws(() => h.call(`paintMotion(${closing.id}, .5, true)`), /Frame inválido/);
  h.invoke('monitor:frame', closing.id, 1, true);
  await h.invoke('monitor:motion');
  assert.deepEqual(h.bounds(), { x: 1750, y: 840, width: 98, height: 194 });
  assert.deepEqual(h.window().getBounds(), host);
});

test('abrir y cerrar usan la duración de alternar; ensanchar para ajustes, la de redimensionar', async () => {
  const h = await startupHarness();
  await h.start(); h.layout(['claude']);
  const layout = (expanded, selectorOpen) => h.invoke('monitor:layout', { expanded, selectorOpen, reduceMotion: false, providers: ['claude'] }).motion.duration;
  assert.equal(layout(true, false), MOTION_MS.toggle);
  assert.equal(layout(true, true), MOTION_MS.resize);
  assert.equal(layout(false, false), MOTION_MS.toggle);
});

test('reducir movimiento termina inmediatamente y los mensajes viejos no lo reviven', async () => {
  const h = await startupHarness();
  await h.start(); h.layout(['claude', 'codex']);
  const layout = reduceMotion => h.invoke('monitor:layout', { expanded: true, selectorOpen: false, reduceMotion, providers: ['claude', 'codex'] });
  const old = layout(false).motion;
  h.invoke('monitor:frame', old.id, .3, false);
  const reduced = layout(true);
  assert.equal(reduced.motion.duration, 0);
  await h.invoke('monitor:motion');
  const target = h.bounds();
  h.invoke('monitor:frame', old.id, .7, false);
  assert.deepEqual(h.bounds(), target);
  assert.equal(target.width, 384);
  const snapshot = layout(true).motion;
  assert.equal(snapshot.duration, 0, 'la recarga recibe la geometría aunque el layout no cambie');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.to)), JSON.parse(JSON.stringify(reduced.motion.to)));
  assert.equal(h.window().ignoresMouse, true);
  h.invoke('monitor:hit-test', true);
  assert.equal(h.window().ignoresMouse, false);
  h.invoke('monitor:hit-test', false);
  assert.equal(h.window().ignoresMouse, true);
  assert.throws(() => h.invoke('monitor:hit-test', 'true'), /puntero inválida/);
});

test('arrastrar desde una apertura hacia la izquierda no recorta el destino dentro de la ventana', async () => {
  const h = await startupHarness({ saved: { x: 1750, y: 840 }, scale: 1.25 });
  await h.start(); h.layout(['claude', 'codex']);
  const motion = h.invoke('monitor:layout', { expanded: true, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] }).motion;
  h.invoke('monitor:frame', motion.id, .5, false);
  h.invoke('monitor:move', 500, 300);
  const host = h.window().getBounds();
  const target = h.bounds();
  assert.equal(target.width, 384);
  assert.ok(target.x >= host.x && target.x + target.width <= host.x + host.width, 'el ancho final debe caber tras cancelar el movimiento');
  assert.ok(target.y >= host.y && target.y + target.height <= host.y + host.height);
});

test('ocultar y mostrar durante el movimiento recupera el cristal nativo', async () => {
  const h = await startupHarness();
  await h.start(); h.layout(['claude', 'codex']);
  h.invoke('monitor:layout', { expanded: true, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] });
  h.glassCalls.length = 0;
  h.window().hide();
  h.window().show();
  assert.deepEqual(h.glassCalls.map(call => call.name), ['hide', 'show']);
});

test('un fallo al reemplazar ajustes conserva el archivo anterior y limpia el temporal', async () => {
  const h = await startupHarness();
  await h.start(); h.layout(['claude']);
  await h.call('writePosition()');
  const previous = h.files.get('profile/window.json');
  h.failSave(); h.invoke('monitor:move', 400, 200);
  await h.call('writePosition()');
  assert.equal(h.files.get('profile/window.json'), previous);
  assert.deepEqual([...h.files.keys()], ['profile/window.json']);
});

test('todos los proveedores visibles u ocultos conservan coordenadas en cinco arranques', async () => {
  for (const providers of [['claude', 'codex'], ['claude'], ['codex'], []]) {
    const positions = [[100, 80], [1200, 500], [1200, 800], [1700, 800]];
    if (providers.length < 2) positions.push([1700, 910]);
    for (const [x, y] of positions) {
      const files = new Map();
      for (let restart = 0; restart < 5; restart++) {
        const h = await startupHarness({ saved: { x, y }, files });
        await h.start();
        h.layout(providers);
        await h.clock.advance(500);
        assert.deepEqual([h.bounds().x, h.bounds().y], [x, y], `${providers}: arranque ${restart}`);
        await h.call('writePosition()');
        assert.deepEqual(JSON.parse(files.get('profile/window.json')), { x, y });
      }
    }
  }
});

test('restaura en pantallas secundarias y acota a la más cercana cuando falta la original', async () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: -200, width: 1280, height: 984 }];
  const h = await startupHarness({ saved: { x: -1100, y: 200 }, displays });
  await h.start(); h.layout(['claude']); await h.clock.advance(500);
  assert.deepEqual(h.bounds(), { x: -1100, y: 200, width: 98, height: 122 });
  const missing = await startupHarness({ saved: { x: 4000, y: 1500 }, displays });
  await missing.start(); missing.layout([]); await missing.clock.advance(500);
  assert.deepEqual(missing.bounds(), { x: 1714, y: 918, width: 206, height: 122 });
  const nearest = await startupHarness({ saved: { x: -2200, y: 200 }, displays });
  await nearest.start(); nearest.layout([]); await nearest.clock.advance(500);
  assert.deepEqual(nearest.bounds(), { x: -1280, y: 200, width: 206, height: 122 });
});

test('el panel nativo falla sin excepciones tras arrancar pero rechaza el arranque si nunca se crea', async () => {
  const h = await startupHarness();
  await h.start(); h.layout(['claude']); await h.clock.advance(500);
  h.failGlass();
  for (const event of ['move', 'resize', 'show']) assert.doesNotThrow(() => h.window().emit(event));
  const startup = await startupHarness();
  startup.failGlass();
  await assert.rejects(startup.start(), /panel nativo/);
});

test('tras una animación, abrir y cerrar parten de la posición que Windows haya reubicado', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 1200, y: 800, width: 98, height: 194 }, clock);
  await h.layout(true, { reduceMotion: false }); await clock.advance(400);
  const expanded = h.widget.getBounds();
  h.widget.setBounds({ ...expanded, x: expanded.x - 200, y: expanded.y - 100 });
  await h.layout(false, { reduceMotion: false }); await clock.advance(400);
  assert.deepEqual(h.bounds(), { x: 1000, y: 700, width: 98, height: 194 });
  const host = h.widget.getBounds();
  h.widget.setPosition(host.x + 300 - h.bounds().x, host.y + 80 - h.bounds().y);
  await h.layout(true, { reduceMotion: false }); await clock.advance(400);
  assert.deepEqual(h.bounds(), { x: 300, y: 80, width: 384, height: 256 });
});

test('arrastrar durante una animación completa el tamaño del panel en la posición nueva', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 100, y: 80, width: 98, height: 194 }, clock);
  await h.layout(true, { reduceMotion: false });
  await clock.advance(128);
  h.handlers['monitor:move'](h.event, 500, 300);
  await clock.advance(1000);
  await h.layout(true);
  assert.deepEqual(h.bounds(), { x: 500, y: 300, width: 384, height: 256 });
  assert.equal(vm.runInContext('glassMorph', h.context), 1);
});

for (const [x, y] of [[900, 80], [100, 240], [100, 590]]) {
  test(`abrir y cerrar conserva la cápsula y su posición guardada en (${x}, ${y})`, async () => {
    const h = await layoutHarness({ x, y, width: 98, height: 194 });
    await h.layout(true);
    await vm.runInContext('writePosition()', h.context);
    assert.deepEqual(h.saved(), { x, y });
    await h.layout(false);
    assert.deepEqual(h.bounds(), { x, y, width: 98, height: 194 });
    assert.deepEqual(h.saved(), { x: h.bounds().x, y: h.bounds().y });
  });
}

test('la ventana permanece inmóvil y el movimiento espera frames del renderer', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 100, y: 80, width: 98, height: 194 }, clock);
  h.autoPaint = false;
  await h.layout(true, { reduceMotion: false });
  const host = h.widget.getBounds();
  await clock.advance(128);
  assert.deepEqual(h.widget.getBounds(), host, 'ningún timer debe mover o redimensionar la ventana');
  assert.equal(h.bounds().width, 98);
});

test('la superficie sigue el progreso de los frames sin redimensionar la ventana', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 100, y: 80, width: 98, height: 194 }, clock);
  const motion = await h.layout(true, { reduceMotion: false });
  await clock.advance(128);
  assert.ok(h.bounds().width > 110, 'el avance debe seguir el progreso del renderer');
  await clock.advance(motion.duration + motion.delay + 16 - 128);
  assert.deepEqual(h.bounds(), { x: 100, y: 80, width: 384, height: 256 });
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
  assert.equal(h.bounds().width, 384);
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
  await clock.advance(240);
  await done;
  assert.equal(finished, true);
  assert.equal(h.bounds().width, 230);
});

test('invertir una apertura en curso conserva la cápsula y guarda su destino final', async () => {
  const clock = createClock(16);
  const h = await layoutHarness({ x: 1750, y: 840, width: 98, height: 194 }, clock);
  await h.layout(true, { reduceMotion: false });
  await clock.advance(64);
  await vm.runInContext('writePosition()', h.context);
  assert.deepEqual(h.saved(), { x: 1750, y: 840 });
  await h.layout(false, { reduceMotion: false });
  await clock.advance(400);
  assert.deepEqual(h.bounds(), { x: 1750, y: 840, width: 98, height: 194 });
});

test('widget IPC conserva dirección, límites, tamaños e invalidación', async () => {
  const h = await layoutHarness({ x: 1750, y: 840, width: 98, height: 194 });
  const transition = await h.layout(true);
  assert.deepEqual(JSON.parse(JSON.stringify(transition.placement)), { horizontal: 'left', vertical: 'up' });
  assert.deepEqual(h.bounds(), { x: 1464, y: 778, width: 384, height: 256 });
  assert.ok(h.bounds().x >= 0 && h.bounds().x + h.bounds().width <= 1920);
  assert.ok(h.bounds().y >= 0 && h.bounds().y + h.bounds().height <= 1040);
  await vm.runInContext('writePosition()', h.context);
  assert.deepEqual(h.saved(), { x: 1750, y: 840 });
  const opened = h.bounds();
  await h.layout(true);
  assert.deepEqual(h.bounds(), opened);
  for (const [expanded, providers, selectorOpen, width, height] of [
    [false, ['claude', 'codex'], false, 98, 194],
    [false, ['claude'], false, 98, 122], [false, [], false, 206, 122],
    [false, ['claude'], false, 98, 122], [true, ['claude'], false, 230, 256],
    [true, ['claude'], true, 384, 256], [false, ['claude'], false, 98, 122],
  ]) {
    await h.layout(expanded, { providers, selectorOpen });
    assert.deepEqual([h.bounds().width, h.bounds().height], [width, height]);
  }
  const zones = vm.runInContext(`[50, 450, 850].flatMap(y => [100, 1700].map(x => placementFor({ x, y, width: 98, height: 122 }, { x: 0, y: 0, width: 1920, height: 1040 })))`, h.context);
  assert.deepEqual(JSON.parse(JSON.stringify(zones)), [
    { horizontal: 'right', vertical: 'down' }, { horizontal: 'left', vertical: 'down' },
    { horizontal: 'right', vertical: 'center' }, { horizontal: 'left', vertical: 'center' },
    { horizontal: 'right', vertical: 'up' }, { horizontal: 'left', vertical: 'up' },
  ]);
  await h.layout(true, { providers: ['claude'] });
  h.handlers['monitor:move'](h.event, 100, 80);
  await h.layout(false, { providers: ['claude'] });
  assert.deepEqual([h.bounds().x, h.bounds().y], [100, 80]);
  h.handlers['monitor:move'](h.event, 100, 200);
  assert.deepEqual([h.bounds().x, h.bounds().y], [100, 200]);
  assert.throws(() => h.handlers['monitor:move'](h.event, NaN, 200));
  assert.throws(() => h.layout('true'));
  assert.throws(() => h.layout(false, { selectorOpen: true }));
  assert.throws(() => h.handlers['monitor:layout']({ sender: {} }, {}), /IPC no autorizado/);
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
    setIgnoreMouseEvents() {}
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
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; }, on: (name, handler) => { handlers[name] = handler; } }, motionRect, MOTION_MS,
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
  assert.equal(vm.runInContext('getSurfaceBounds().width', context), 98, 'reloading must match the renderer, which starts collapsed');
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
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} }, contents,
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
    ipcMain: { handle() {}, on() {} }, process: { pid: 1 }, recordShow: () => { shown++; }, recordFocus: () => { focused++; },
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
