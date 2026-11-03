import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

function isExecutable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/**
 * Resuelve un ejecutable en el PATH sin delegar en el shell, para no exponer la
 * línea de comandos a interpretación. Devuelve `null` si la herramienta no está.
 */
export function resolveExecutable(name, env = process.env) {
  if (name.includes(path.sep) || name.includes('/')) return isExecutable(name) ? name : null;
  const extensions = WINDOWS
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Lanza una CLI local resolviendo antes su ruta real. En Windows los envoltorios
 * `.cmd`/`.bat` se ejecutan a través de ComSpec con argumentos literales, nunca
 * concatenando una cadena de shell.
 */
export function spawnCli(name, args, options = {}) {
  const env = options.env || process.env;
  const file = resolveExecutable(name, env);
  if (!file) throw new Error(`No encontré ${name} en el PATH`);
  const stdio = options.stdio || ['pipe', 'pipe', 'ignore'];
  const base = { stdio, windowsHide: true, env };
  if (WINDOWS && /\.(cmd|bat)$/i.test(file)) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const quote = value => {
      const text = String(value);
      if (/[\r\n\0]/.test(text)) throw new Error('Argumento inválido para el wrapper de Windows');
      if (text.includes('%')) throw new Error('El carácter % no está soportado en rutas o argumentos del wrapper de Windows');
      return `"${text.replaceAll('"', '""')}"`;
    };
    // cmd.exe exige comillas exteriores adicionales cuando el ejecutable entre comillas sigue a /c.
    const command = `"${[file, ...args].map(quote).join(' ')}"`;
    return spawn(comspec, ['/d', '/v:off', '/s', '/c', command], { ...base, windowsVerbatimArguments: true });
  }
  return spawn(file, args, base);
}
