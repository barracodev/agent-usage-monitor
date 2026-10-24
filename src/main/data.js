import readline from 'node:readline';
import { normalizeClaudeUsage, normalizeCodexUsage } from '../core/limits.js';
import { spawnCli } from './process.js';

const MAX_RPC_LINES = 500;

export function createClaudeClient(options = {}) {
  const spawnImpl = options.spawnCliImpl || spawnCli;
  const timeoutMs = options.timeoutMs || 12000;
  let server = null;
  let nextId = 1;

  function request(current, payload) {
    return new Promise((resolve, reject) => {
      if (server !== current) return reject(new Error('Claude Code cerrado'));
      const id = String(nextId++);
      const timer = setTimeout(() => current.stop(new Error('Claude Code no respondió')), timeoutMs);
      current.pending.set(id, { resolve, reject, timer });
      current.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: payload })}\n`);
    });
  }

  function start() {
    // El bloqueo de todo tráfico no esencial también impide consultar las cuotas.
    const child = spawnImpl('claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--safe-mode', '--strict-mcp-config'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1', DISABLE_AUTOUPDATER: '1' } });
    const current = { child, pending: new Map(), seen: 0 };
    const lines = readline.createInterface({ input: child.stdout });
    current.stop = error => {
      if (server !== current) return;
      server = null;
      lines.close();
      child.stdout?.removeAllListeners();
      child.stdin?.removeAllListeners('error');
      try { child.stdin?.end(); } catch { /* cerrado */ }
      try { child.kill(); } catch { /* cerrado */ }
      child.unref?.();
      for (const pending of current.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      current.pending.clear();
    };
    server = current;
    child.once('error', error => current.stop(error));
    child.once('close', () => current.stop(new Error('Claude Code terminó sin responder')));
    child.stdin?.on('error', () => current.stop(new Error('No pude hablar con Claude Code')));
    lines.on('line', line => {
      if (current.pending.size && ++current.seen > MAX_RPC_LINES) return current.stop(new Error('Claude Code respondió de más'));
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== 'control_response') return;
      const reply = message.response;
      const pending = current.pending.get(reply?.request_id);
      if (!pending) return;
      current.pending.delete(reply.request_id);
      current.seen = 0;
      clearTimeout(pending.timer);
      if (reply.subtype === 'success') pending.resolve(reply.response);
      else pending.reject(new Error('Claude Code no pudo consultar los límites de la cuenta'));
    });
    current.ready = request(current, { subtype: 'initialize' }).catch(error => {
      current.stop(error);
      throw error;
    });
    return current;
  }

  async function read() {
    const current = server || start();
    await current.ready;
    // shortcut: get_usage es experimental; adaptar si Claude Code cambia su protocolo.
    const data = await request(current, { subtype: 'get_usage', skip_behaviors: true });
    const limits = data?.rate_limits_available === false ? null : normalizeClaudeUsage(data?.rate_limits);
    if (!limits) throw new Error('Claude no entregó una ventana de 5 horas válida');
    return limits;
  }

  return { read, close: () => server?.stop(new Error('Claude Code cerrado')) };
}

function codexLimitsFrom(message) {
  if (message.error) throw new Error(message.error.message || 'Codex app-server falló');
  const limits = normalizeCodexUsage(message.result || {});
  if (!limits) throw new Error('Codex no devolvió la ventana primaria de 5 horas');
  return limits;
}

/**
 * Mantiene vivo un `codex app-server` para leer la ventana de cinco horas sin lanzar procesos
 * en cada consulta. Si el proceso muere o no responde, se rechaza lo pendiente y la siguiente
 * lectura lo relanza; un error de la propia lectura no lo reinicia.
 */
export function createCodexClient(options = {}) {
  const spawnImpl = options.spawnCliImpl || spawnCli;
  const timeoutMs = options.timeoutMs || 12000;
  let server = null;
  let nextId = 1;
  const write = (current, message) => { if (server === current) current.child.stdin.write(`${JSON.stringify(message)}\n`); };

  function request(current, method, params, parse = message => message.result) {
    return new Promise((resolve, reject) => {
      if (server !== current) return reject(new Error('Codex app-server cerrado'));
      const id = nextId++;
      const timer = setTimeout(() => current.stop(new Error('Codex app-server no respondió')), timeoutMs);
      current.pending.set(id, { resolve, reject, timer, parse });
      write(current, { method, id, params });
    });
  }

  function start() {
    const child = spawnImpl('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const current = { child, pending: new Map(), seen: 0 };
    const lines = readline.createInterface({ input: child.stdout });
    current.stop = error => {
      if (server !== current) return;
      server = null;
      lines.close();
      child.stdout?.removeAllListeners();
      child.stdin?.removeAllListeners('error');
      try { child.stdin?.end(); } catch { /* cerrado */ }
      try { child.kill(); } catch { /* cerrado */ }
      child.unref?.();
      for (const request of current.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      current.pending.clear();
    };
    server = current;
    child.once('error', error => current.stop(error));
    child.once('close', () => current.stop(new Error('Codex app-server terminó sin responder')));
    child.stdin?.on('error', () => current.stop(new Error('No pude hablar con Codex app-server')));
    lines.on('line', line => {
      if (current.pending.size && ++current.seen > MAX_RPC_LINES) return current.stop(new Error('Codex app-server respondió de más'));
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const request = current.pending.get(message.id);
      if (!request) return;
      current.pending.delete(message.id);
      current.seen = 0;
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || 'Codex app-server falló'));
      else try { request.resolve(request.parse(message)); } catch (error) { request.reject(error); }
    });
    current.ready = request(current, 'initialize', { clientInfo: { name: 'agent-usage-monitor', title: 'Agent Usage Monitor', version: '0.1.0' } })
      .then(() => write(current, { method: 'initialized', params: {} }))
      .catch(error => {
        current.stop(error);
        throw error;
      });
    return current;
  }

  async function read() {
    const current = server || start();
    await current.ready;
    // Sin el detalle de créditos cada lectura es una sola petición al backend.
    return request(current, 'account/rateLimits/read', { excludeResetCreditDetails: true }, codexLimitsFrom);
  }

  return { read, close: () => server?.stop(new Error('Codex app-server cerrado')) };
}
