import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync } from 'node:fs';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable, spawnCli } from '../src/main/process.js';

test('resolveExecutable busca en el PATH sin usar el shell', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-monitor-bin-'));
  const name = process.platform === 'win32' ? 'herramienta.cmd' : 'herramienta';
  const file = path.join(dir, name);
  await writeFile(file, '');
  chmodSync(file, 0o755);

  // La extensión sale del PATHEXT, que en Windows viene en mayúsculas y no distingue caso.
  const env = { PATH: dir, PATHEXT: '.CMD' };
  assert.equal(resolveExecutable('herramienta', env).toLowerCase(), file.toLowerCase());
  assert.equal(resolveExecutable('no-existe', env), null);
});

test('spawnCli ejecuta un wrapper cmd aunque su ruta tenga espacios', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage monitor bin-'));
  const file = path.join(dir, 'herramienta.cmd');
  await writeFile(file, '@echo off\r\necho %~1\r\n');

  const child = spawnCli('herramienta', ['hola mundo'], {
    env: { ...process.env, PATH: dir, PATHEXT: '.CMD' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), 'hola mundo');
});

test('spawnCli rechaza con claridad porcentajes en rutas cmd sin ejecutarlos', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-monitor-100%-'));
  const file = path.join(dir, 'herramienta.cmd');
  try {
    await writeFile(file, '@echo off\r\necho inesperado\r\n');
    assert.throws(() => spawnCli('herramienta', [], {
      env: { ...process.env, PATH: dir, PATHEXT: '.CMD' },
    }), /%.*wrapper de Windows/);
  } finally { await unlink(file); await rmdir(dir); }
});
