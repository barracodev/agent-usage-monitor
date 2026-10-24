import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import * as data from '../src/main/data.js';
const { createCodexClient } = data;

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.unref = () => {};
  return child;
}

function fakeClaude(children, { respond = true, reply, failInitialize = false } = {}) {
  const child = fakeChild();
  child.requests = [];
  child.usedPercent = 4;
  readline.createInterface({ input: child.stdin }).on('line', line => {
    const message = JSON.parse(line);
    child.requests.push(message);
    if (message.request.subtype === 'initialize' && failInitialize) {
      child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'initialization failed' } })}\n`);
      return;
    }
    if (message.request.subtype !== 'initialize' && !respond) return;
    const body = message.request.subtype === 'initialize' ? {} : reply?.() ?? {
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: child.usedPercent, resets_at: '2026-10-21T05:49:00Z' }, seven_day: { utilization: 80 } },
      session: { secret: 'not-for-widget' },
    };
    child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: body } })}\n`);
  });
  children.push(child);
  return child;
}

test('Claude lee uso de cuenta actualizado sin mandar mensajes al modelo', async () => {
  const children = [];
  let received;
  const client = data.createClaudeClient({ spawnCliImpl: (name, args, options) => {
    received = { name, args, options };
    return fakeClaude(children, { reply: () => options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ? { rate_limits_available: true, rate_limits: null } : undefined });
  } });
  try {
    const first = await client.read();
    assert.equal(first.usedPercent, 4);
    assert.equal(first.provider, 'claude');
    assert.equal(first.resetsAt, Date.parse('2026-10-21T05:49:00Z'));
    assert.deepEqual(Object.keys(first).sort(), ['fetchedAt', 'provider', 'resetsAt', 'usedPercent']);
    children[0].usedPercent = 23;
    assert.equal((await client.read()).usedPercent, 23);
    assert.equal(children.length, 1);
    assert.equal(received.name, 'claude');
    assert.ok(received.args.includes('--safe-mode'));
    assert.ok(received.args.includes('--no-session-persistence'));
    assert.equal(received.options.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
    for (const key of ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DO_NOT_TRACK', 'DISABLE_AUTOUPDATER']) assert.equal(received.options.env[key], '1');
    assert.equal(received.options.shell, undefined);
    assert.ok(children[0].requests.every(message => message.type === 'control_request'));
    assert.deepEqual(children[0].requests.map(message => message.request.subtype), ['initialize', 'get_usage', 'get_usage']);
    assert.ok(children[0].requests.filter(message => message.request.subtype === 'get_usage').every(message => message.request.skip_behaviors === true));
  } finally { client.close(); }
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(children[0].killed, true);
});

test('Claude rechaza datos ausentes o inválidos y permite recuperar la lectura', async () => {
  const children = [];
  let body = {};
  const client = data.createClaudeClient({ spawnCliImpl: () => fakeClaude(children, { reply: () => body }) });
  try {
    for (const invalid of [null, '', false, 'mucho']) {
      body = { rate_limits_available: true, rate_limits: { five_hour: { utilization: invalid } } };
      await assert.rejects(client.read(), /ventana|límites/);
    }
    body = { rate_limits_available: false, rate_limits: { five_hour: { utilization: 20 } } };
    await assert.rejects(client.read(), /ventana|límites/);
    body = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 0 } } };
    assert.equal((await client.read()).usedPercent, 0);
    assert.equal(children.length, 1);
  } finally { client.close(); }
});

test('Claude descarta el cliente si muere y lo relanza en la siguiente lectura', async () => {
  const children = [];
  const client = data.createClaudeClient({ spawnCliImpl: () => fakeClaude(children, { respond: children.length > 0 }) });
  try {
    const pending = client.read();
    await new Promise(resolve => setImmediate(resolve));
    children[0].emit('close', 1);
    await assert.rejects(pending, /terminó/);
    assert.equal((await client.read()).usedPercent, 4);
    assert.equal(children.length, 2);
  } finally { client.close(); }
});

test('Claude vence una lectura colgada y rechaza si la CLI no está instalada', async () => {
  const children = [];
  const client = data.createClaudeClient({ timeoutMs: 20, spawnCliImpl: () => fakeClaude(children, { respond: false }) });
  await assert.rejects(client.read(), /no respondió/);
  assert.equal(children[0].killed, true);
  const absent = data.createClaudeClient({ spawnCliImpl: () => { throw new Error('No encontré claude en el PATH'); } });
  await assert.rejects(absent.read(), /PATH/);
});

test('Claude rechaza errores del protocolo e ignora respuestas de otra petición', async () => {
  const children = [];
  const client = data.createClaudeClient({ spawnCliImpl: () => fakeClaude(children, { respond: false }) });
  try {
    const pending = client.read();
    await new Promise(resolve => setImmediate(resolve));
    const child = children[0];
    child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'other', response: {} } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: child.requests.at(-1).request_id, error: 'unsupported get_usage' } })}\n`);
    await assert.rejects(pending, /consultar los límites/);
  } finally { client.close(); }
});

test('Cerrar Claude durante la inicialización no escribe después de cerrar stdin', async () => {
  const child = fakeChild();
  const client = data.createClaudeClient({ spawnCliImpl: () => child });
  const pending = client.read();
  child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: '1', response: {} } })}\n`);
  client.close();
  await assert.rejects(pending, /cerrado/);
  assert.equal(child.stdin.writableEnded, true);
});

test('Claude vuelve a inicializar después de fallar la conexión inicial', async () => {
  const children = [];
  const client = data.createClaudeClient({ spawnCliImpl: () => fakeClaude(children, { failInitialize: children.length === 0 }) });
  try {
    await assert.rejects(client.read(), /consultar los límites/);
    assert.equal(children[0].killed, true);
    assert.equal((await client.read()).usedPercent, 4);
    assert.equal(children.length, 2);
  } finally { client.close(); }
});

// App-server falso: exige completar el handshake antes de aceptar lecturas.
function fakeCodex(children, { respond = true, reply } = {}) {
  const child = fakeChild();
  child.requests = [];
  child.usedPercent = 28;
  child.initialized = false;
  readline.createInterface({ input: child.stdin }).on('line', line => {
    const message = JSON.parse(line);
    child.requests.push(message);
    if (message.method === 'initialize') {
      setImmediate(() => {
        child.initialized = true;
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'usage-monitor-test' } })}\n`);
      });
      return;
    }
    if (message.method !== 'account/rateLimits/read' || !child.initialized || !respond) return;
    const payload = reply?.(message) ?? { result: { rateLimits: { primary: { usedPercent: child.usedPercent, windowDurationMins: 300 } } } };
    child.stdout.write('{"method":"account/rateLimits/updated","params":{}}\n');
    child.stdout.write(`${JSON.stringify({ id: message.id, ...payload })}\n`);
  });
  children.push(child);
  return child;
}

test('createCodexClient reutiliza un app-server sin shell y pide lecturas ligeras', async () => {
  const children = [];
  let received;
  const client = createCodexClient({ timeoutMs: 1000, spawnCliImpl: (name, args, options) => { received = { name, args, options }; return fakeCodex(children); } });
  assert.equal((await client.read()).usedPercent, 28);
  children[0].usedPercent = 35;
  assert.equal((await client.read()).usedPercent, 35);
  assert.equal(children.length, 1);
  assert.deepEqual([received.name, received.args, received.options.shell], ['codex', ['app-server', '--stdio'], undefined]);
  const reads = children[0].requests.filter(message => message.method === 'account/rateLimits/read');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(message => message.params?.excludeResetCreditDetails === true));
  assert.equal(children[0].requests.filter(message => message.method === 'initialize').length, 1);
  assert.deepEqual(children[0].requests.slice(0, 3).map(message => message.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  client.close();
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(children[0].killed, true);
});

test('createCodexClient rechaza errores de lectura sin relanzar el proceso', async () => {
  const children = [];
  let fail = true;
  const client = createCodexClient({ spawnCliImpl: () => fakeCodex(children, { reply: () => fail ? { error: { message: 'chatgpt authentication required' } } : null }) });
  await assert.rejects(client.read(), /authentication required/);
  fail = false;
  assert.equal((await client.read()).usedPercent, 28);
  assert.equal(children.length, 1);
  client.close();
});

test('createCodexClient rechaza si el app-server muere y lo relanza en la siguiente lectura', async () => {
  const children = [];
  const client = createCodexClient({ spawnCliImpl: () => fakeCodex(children, { respond: children.length > 0 }) });
  const pending = client.read();
  await new Promise(resolve => setImmediate(resolve));
  children[0].emit('close', 1);
  await assert.rejects(pending, /terminó/);
  assert.equal((await client.read()).usedPercent, 28);
  assert.equal(children.length, 2);
  client.close();
});

test('createCodexClient vence una lectura colgada y descarta el proceso', async () => {
  const children = [];
  const client = createCodexClient({ timeoutMs: 20, spawnCliImpl: () => fakeCodex(children, { respond: false }) });
  await assert.rejects(client.read(), /no respondió/);
  assert.equal(children[0].killed, true);
});

test('createCodexClient rechaza si codex no está instalado', async () => {
  const client = createCodexClient({ spawnCliImpl: () => { throw new Error('No encontré codex en el PATH'); } });
  await assert.rejects(client.read(), /PATH/);
});
