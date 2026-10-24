import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname, '..');
app.setPath('userData', path.join(root, 'dist', 'qa-profile'));
app.on('window-all-closed', () => {});
let fixture;
ipcMain.handle('qa:read', () => fixture);
ipcMain.handle('qa:layout', (event, layout) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const count = layout.providers.length;
  const slots = Math.max(1, count);
  const collapsedHeight = 56 + 16 + slots * 50 + (slots - 1) * 22;
  const adaptiveWidth = 56 + 20 + Math.max(1, count) * 154;
  const collapsedWidth = count ? 98 : 206;
  const width = layout.expanded ? (layout.selectorOpen ? Math.max(adaptiveWidth, 384) : adaptiveWidth) : collapsedWidth;
  win.setBounds({ ...win.getBounds(), width, height: layout.expanded ? 256 : collapsedHeight });
  return { placement: { horizontal: 'right', vertical: 'down' }, duration: 0, delay: 0 };
});
ipcMain.handle('qa:move', (event, x, y) => BrowserWindow.fromWebContents(event.sender).setPosition(Math.round(x), Math.round(y)));
const inspect = `(() => {
  const widget = document.querySelector('.widget');
  const style = getComputedStyle(widget);
  return {
    fonts: [...document.fonts].map(font => font.status),
    widget: widget.getBoundingClientRect().toJSON(),
    radius: style.borderTopLeftRadius,
    hasQuit: Boolean(document.querySelector('#quit')),
    cells: [...document.querySelectorAll('.provider')].map(element => ({
      key: element.dataset.provider,
      bounds: element.getBoundingClientRect().toJSON(),
      gauge: element.querySelector('.gauge').getBoundingClientRect().toJSON(),
      figure: element.querySelector('.figure').getBoundingClientRect().toJSON(),
      arc: element.querySelector('.fill').style.strokeDasharray,
      iconLoaded: element.querySelector('img').complete && element.querySelector('img').naturalWidth > 0,
      overflow: element.scrollWidth > element.clientWidth,
    })),
    text: [...document.querySelectorAll('.figure')].map(element => element.textContent),
    expanded: document.querySelector('#toggle').getAttribute('aria-expanded'),
    bars: [...document.querySelectorAll('.bar-fill')].map(element => element.style.height),
    details: [...document.querySelectorAll('.detail-figure')].map(element => element.textContent),
    footer: document.querySelector('#footer').getBoundingClientRect().toJSON(),
    footerText: document.querySelector('#footer').textContent,
    settingsOpen: !document.querySelector('#settings-menu').hidden,
    settingsRows: [...document.querySelectorAll('.provider-setting')].map(element => element.textContent.trim()),
    emptyVisible: !document.querySelector('#empty-state').hidden,
    emptyText: document.querySelector('#empty-state').textContent.trim(),
  };
})()`;
// capturePage sobre ventanas ocultas falla a veces con UnknownVizError del compositor.
async function capture(win) {
  for (let attempt = 1; ; attempt++) {
    try { return await win.webContents.capturePage(); }
    catch (error) { if (attempt === 3) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
}

async function waitForPanel(win, expanded) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await win.webContents.executeJavaScript(`(() => { const widget = document.querySelector('.widget'); return { expanded: widget.classList.contains('expanded'), moving: widget.classList.contains('opening') || widget.classList.contains('closing') }; })()`);
    if (state.expanded === expanded && !state.moving) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`La transición del panel no terminó: expanded=${expanded}`);
}

async function checkWindowTiming() {
  const source = (await readFile(path.join(root, 'src/main/index.js'), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', '"file:///widget"');
  const win = new BrowserWindow({ x: 100, y: 80, width: 98, height: 194, frame: false, transparent: true, resizable: false, show: false });
  try {
    const context = vm.createContext({ path, fileURLToPath: () => root, performance, setTimeout,
      createClaudeClient: () => ({}), createCodexClient: () => ({}),
      app: { requestSingleInstanceLock: () => false, quit() {} }, ipcMain: { handle() {} }, win,
      screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    });
    vm.runInContext(source, context);
    vm.runInContext('mainWindow = win', context);
    for (const expanded of [true, false]) {
      const startedAt = performance.now();
      const motion = vm.runInContext(`applyLayout({ expanded: ${expanded}, selectorOpen: false, reduceMotion: false, providers: ['claude', 'codex'] })`, context);
      await vm.runInContext('boundsMotion', context);
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= motion.duration + motion.delay, 'la ventana debe completar toda la duración declarada');
      assert.ok(elapsed < motion.duration + motion.delay + 64, `la animación se alargó: ${elapsed} ms`);
      assert.ok(Math.abs(win.getBounds().width - (expanded ? 384 : 98)) <= 1, JSON.stringify(win.getBounds()));
      console.log(`ventana ${expanded ? 'abrir' : 'cerrar'}: ${Math.round(elapsed)} ms (declarados ${motion.duration + motion.delay} ms)`);
    }
  } finally { win.destroy(); }
}

async function checkIcons(win) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const widget = document.querySelector('.widget');
    const footer = document.querySelector('#footer');
    const menu = document.querySelector('#settings-menu');
    widget.classList.add('glass');
    const colors = [];
    for (const light of [false, true]) {
      footer.classList.toggle('light-text', light);
      menu.classList.toggle('light-text', light);
      for (const icon of document.querySelectorAll('.ui-icon')) {
        const style = getComputedStyle(icon);
        const image = new Image();
        image.src = style.maskImage.slice(5, -2);
        await image.decode();
        if (style.backgroundColor !== style.color) throw new Error('El icono perdió currentColor');
      }
      colors.push(getComputedStyle(document.querySelector('#settings .ui-icon')).backgroundColor);
    }
    widget.classList.remove('glass');
    footer.classList.remove('light-text');
    menu.classList.remove('light-text');
    return colors;
  })()`);
  assert.deepEqual(result, ['rgb(41, 41, 46)', 'rgb(255, 255, 255)']);
}
app.whenReady().then(async () => {
  let win;
  try {
    nativeTheme.themeSource = 'light';
    await checkWindowTiming();
    await session.defaultSession.clearStorageData({ storages: ['localstorage'] });
    const entry = usedPercent => ({ value: { usedPercent, resetsAt: Date.now() + 600000 }, fetchedAt: Date.now() });
    const cases = [
      ['normal', entry(42), entry(27)],
      ['aviso', entry(80), entry(94)],
      ['agotado', entry(100), entry(100)],
      ['sin-datos-stale', { value: null }, { ...entry(55), stale: true }],
      ['instalacion', { value: null }, entry(0)],
      ['envejecido', { ...entry(64), aged: true, fetchedAt: Date.now() - 42 * 60000 }, entry(12)],
    ];
    await mkdir(path.join(root, 'artifacts/wireframe'), { recursive: true });
    for (const [name, claude, codex] of cases) {
      fixture = { limits: { claude, codex }, providers: [{ key: 'claude', name: 'Claude', installed: true }, { key: 'codex', name: 'Codex', installed: true }] };
      win = new BrowserWindow({ width: 98, height: 194, frame: false, transparent: true, resizable: false, show: false, webPreferences: { preload: path.join(root, 'scripts/visual-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      const errors = [];
      win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
      await win.loadFile(path.join(root, 'src/renderer/index.html'));
      await win.webContents.executeJavaScript('document.fonts.ready');
      await new Promise(resolve => setTimeout(resolve, 200));
      const result = await win.webContents.executeJavaScript(inspect);
      assert.deepEqual(result.fonts, ['loaded']);
      assert.equal(result.hasQuit, false);
      assert.deepEqual([result.widget.width, result.widget.height], [42, 138]);
      assert.equal(result.radius, '21px');
      assert.deepEqual(result.cells.map(cell => cell.key), ['claude', 'codex']);
      assert.ok(result.cells[0].figure.bottom < result.cells[1].gauge.top);
      for (const [index, cell] of result.cells.entries()) {
        const source = [claude, codex][index];
        assert.equal(cell.arc, `${source.value && !source.stale ? source.value.usedPercent : 0}, 100`);
        assert.equal(cell.gauge.width, cell.gauge.height);
        assert.ok(cell.gauge.bottom < cell.figure.top);
        assert.equal(cell.iconLoaded, true);
        assert.equal(cell.overflow, false);
      }
      for (const rect of result.cells.flatMap(cell => [cell.gauge, cell.figure])) {
        assert.ok(rect.left >= result.widget.left && rect.right <= result.widget.right && rect.top >= result.widget.top && rect.bottom <= result.widget.bottom, `${name}: elemento fuera de la cápsula`);
      }
      if (name === 'agotado') assert.deepEqual(result.text, ['100%', '100%']);
      if (name === 'sin-datos-stale') assert.deepEqual(result.text, ['—', 'Stale']);
      assert.deepEqual(errors, []);
      await writeFile(path.join(root, `artifacts/wireframe/${name}.png`), (await capture(win)).toPNG());
      win.webContents.sendInputEvent({ type: 'mouseDown', x: 49, y: 43, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: 49, y: 43, button: 'left', clickCount: 1 });
      await waitForPanel(win, true);
      const detail = await win.webContents.executeJavaScript(inspect);
      assert.equal(detail.expanded, 'true');
      assert.deepEqual(win.getContentSize(), [384, 256]);
      assert.deepEqual([detail.widget.width, detail.widget.height], [328, 200]);
      assert.deepEqual(detail.details, [claude, codex].map(source => Number.isFinite(source.value?.usedPercent) ? `${Math.floor(source.value.usedPercent)}%` : '?'));
      assert.deepEqual(detail.bars, [claude, codex].map(source => `${source.value?.usedPercent || 0}%`));
      assert.ok(detail.cells[0].bounds.right < detail.cells[1].bounds.left);
      assert.ok(detail.cells.every(cell => !cell.overflow), `${name}: texto fuera del panel`);
      assert.ok(detail.footer.bottom < detail.widget.bottom);
      assert.doesNotMatch(detail.footerText, /Cuota de 5 h/);
      assert.deepEqual(errors, []);
      await writeFile(path.join(root, `artifacts/wireframe/${name}-detalle.png`), (await capture(win)).toPNG());
      if (name === 'normal') {
        await win.webContents.executeJavaScript("document.querySelector('#settings').click()");
        await new Promise(resolve => setTimeout(resolve, 100));
        const settings = await win.webContents.executeJavaScript(inspect);
        assert.equal(settings.settingsOpen, true);
        assert.deepEqual(settings.settingsRows, ['ClaudeInstalada', 'CodexInstalada']);
        await checkIcons(win);
        win.webContents.debugger.attach('1.3');
        const { nodes } = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
        const controls = nodes.filter(node => !node.ignored && node.role?.value === 'checkbox');
        assert.deepEqual(controls.map(node => node.name.value), ['Ocultar Claude', 'Ocultar Codex']);
        assert.ok(controls.every(node => node.properties.some(property => property.name === 'checked' && property.value.value === 'true')));
        assert.ok(!nodes.some(node => !node.ignored && ['listbox', 'option'].includes(node.role?.value)));
        win.webContents.debugger.detach();
        assert.ok(settings.footer.bottom < settings.widget.bottom, 'los ajustes no deben expulsar el pie del panel');
        await writeFile(path.join(root, 'artifacts/wireframe/normal-ajustes.png'), (await capture(win)).toPNG());
        await win.webContents.executeJavaScript("document.querySelector('[data-action=\"toggle-provider\"][data-provider=\"codex\"]').click()");
        await new Promise(resolve => setTimeout(resolve, 180));
        const hidden = await win.webContents.executeJavaScript(inspect);
        assert.deepEqual(hidden.cells.map(cell => cell.key), ['claude']);
        await win.webContents.executeJavaScript("document.querySelector('[data-action=\"toggle-provider\"][data-provider=\"claude\"]').click()");
        await win.webContents.executeJavaScript("document.querySelector('#settings').click()");
        await new Promise(resolve => setTimeout(resolve, 220));
        const empty = await win.webContents.executeJavaScript(inspect);
        assert.equal(empty.emptyVisible, true);
        assert.match(empty.emptyText, /Sin IA visibles/);
        await writeFile(path.join(root, 'artifacts/wireframe/normal-sin-ias.png'), (await capture(win)).toPNG());
        await win.webContents.executeJavaScript("document.querySelector('#settings').click()");
        await new Promise(resolve => setTimeout(resolve, 80));
        await win.webContents.executeJavaScript("document.querySelector('[data-action=\"toggle-provider\"][data-provider=\"claude\"]').click()");
        await win.webContents.executeJavaScript("document.querySelector('#settings').click()");
        await new Promise(resolve => setTimeout(resolve, 220));
        const [oneWidth, oneHeight] = win.getContentSize();
        assert.ok(oneWidth >= 230 && oneWidth <= 231 && oneHeight === 256, 'one provider must narrow the expanded window');
        const oneDetail = await win.webContents.executeJavaScript(inspect);
        assert.deepEqual([oneDetail.widget.width, oneDetail.widget.height], [174, 200]);
        await win.webContents.executeJavaScript("document.querySelector('#toggle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
        await waitForPanel(win, false);
        const [compactWidth, compactHeight] = win.getContentSize();
        assert.ok(compactWidth >= 98 && compactWidth <= 99 && compactHeight >= 122 && compactHeight <= 123, 'one provider must shorten the collapsed window');
        await win.webContents.executeJavaScript("document.querySelector('#toggle').click()");
        await waitForPanel(win, true);
        await win.webContents.executeJavaScript("document.querySelector('#settings').click()");
        await new Promise(resolve => setTimeout(resolve, 50));
        await win.webContents.executeJavaScript("document.querySelector('[data-action=\"toggle-provider\"][data-provider=\"codex\"]').click()");
        await win.webContents.executeJavaScript("document.querySelector('#settings').click()");
        await new Promise(resolve => setTimeout(resolve, 180));
        assert.deepEqual(win.getContentSize(), [384, 256]);
      }
      await win.webContents.executeJavaScript("document.querySelector('#toggle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      await waitForPanel(win, false);
      // Windows redondea hasta un píxel al volver a la cápsula con escala fraccionaria.
      const [width, height] = win.getContentSize();
      assert.ok(width >= 98 && width <= 99 && height >= 194 && height <= 195);
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('#toggle').getAttribute('aria-expanded')"), 'false');
      console.log(name, 'OK');
      win.destroy();
      win = null;
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
