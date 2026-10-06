import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { planTask } from './agent.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 10000);
const pairingCode = process.env.PAIRING_CODE;
const sessions = new Map();
const devices = new Map();
const sockets = new Map();
const frames = new Map();
const liveSignals = new Map();
const allowedActions = new Set(['open_app', 'open_url', 'tap', 'swipe', 'type_text', 'press_back', 'press_home', 'press_recents', 'get_status', 'request_screenshot', 'stop_session']);

if (!pairingCode || pairingCode.length < 8) {
  console.error('PAIRING_CODE must be set and contain at least 8 characters');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const json = (res, status, body) => res.status(status).json(body);
const newToken = () => crypto.randomBytes(32).toString('base64url');
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9._:-]{3,80}$/.test(value);

app.get('/health', (_req, res) => json(res, 200, { ok: true, service: 'manus-android-authorized-backend', version: '0.1.0' }));

app.post('/v1/pair', (req, res) => {
  const { deviceId, code, deviceName } = req.body || {};
  if (!validId(deviceId) || typeof code !== 'string' || code.length < 8) return json(res, 400, { error: 'invalid_pairing_request' });
  const codeBytes = Buffer.from(code);
  const expectedBytes = Buffer.from(pairingCode);
  if (codeBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(codeBytes, expectedBytes)) return json(res, 401, { error: 'pairing_denied' });
  const token = newToken();
  const sessionId = crypto.randomUUID();
  sessions.set(token, { sessionId, deviceId, createdAt: Date.now(), active: true });
  devices.set(deviceId, { deviceId, deviceName: typeof deviceName === 'string' ? deviceName.slice(0, 80) : '', lastSeen: Date.now(), sessionId });
  return json(res, 201, { sessionId, token, expiresInSeconds: 3600, websocketPath: '/v1/control' });
});

app.get('/v1/devices', (req, res) => {
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY) return json(res, 401, { error: 'unauthorized' });
  const active = new Set([...sessions.values()].filter(item => item.active).map(item => item.sessionId));
  return json(res, 200, { devices: [...devices.values()].filter(item => active.has(item.sessionId)).map(({ deviceId, deviceName, lastSeen, sessionId }) => ({ deviceId, deviceName, lastSeen, sessionId })) });
});

app.post('/v1/sessions/:sessionId/frame', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '2mb' }), (req, res) => {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = sessions.get(token);
  if (!session || !session.active || session.sessionId !== req.params.sessionId) return json(res, 401, { error: 'unauthorized' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return json(res, 400, { error: 'invalid_frame' });
  frames.set(session.sessionId, { data: req.body, at: Date.now() });
  return json(res, 202, { accepted: true, at: Date.now() });
});

app.get('/v1/sessions/:sessionId/frame', (req, res) => {
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY) return json(res, 401, { error: 'unauthorized' });
  const frame = frames.get(req.params.sessionId);
  if (!frame || Date.now() - frame.at > 10000) return json(res, 404, { error: 'frame_not_available' });
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(frame.data);
});

app.post('/v1/sessions/:sessionId/live/signal', (req, res) => {
  const session = [...sessions.values()].find(item => item.sessionId === req.params.sessionId && item.active);
  const auth = req.header('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const deviceAuthorized = session && sessions.get(bearer)?.sessionId === session.sessionId;
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY && !deviceAuthorized) return json(res, 401, { error: 'unauthorized' });
  if (!session) return json(res, 404, { error: 'active_session_not_found' });
  const { type, data = {} } = req.body || {};
  if (!['offer', 'answer', 'ice', 'state'].includes(type)) return json(res, 400, { error: 'invalid_signal_type' });
  liveSignals.set(session.sessionId, { type, data, at: Date.now() });
  const ws = sockets.get(session.sessionId);
  if (ws?.readyState === 1 && type !== 'offer') ws.send(JSON.stringify({ type: 'live_signal', signal: { type, data } }));
  return json(res, 202, { accepted: true, type });
});

app.get('/v1/sessions/:sessionId/live/signal', (req, res) => {
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY) return json(res, 401, { error: 'unauthorized' });
  const signal = liveSignals.get(req.params.sessionId);
  if (!signal || Date.now() - signal.at > 30000) return json(res, 404, { error: 'signal_not_available' });
  return json(res, 200, signal);
});

app.post('/v1/sessions/:sessionId/stop', (req, res) => {
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY) return json(res, 401, { error: 'unauthorized' });
  let stopped = false;
  for (const [token, session] of sessions) if (session.sessionId === req.params.sessionId) { session.active = false; sessions.set(token, session); stopped = true; }
  return json(res, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'session_not_found' });
});

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/v1/control') return socket.destroy();
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

wss.on('connection', (ws, request) => {
  const auth = request.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = sessions.get(token);
  if (!session || !session.active) { ws.close(1008, 'unauthorized'); return; }
  sockets.set(session.sessionId, ws);
  ws.send(JSON.stringify({ type: 'session_ready', sessionId: session.sessionId, deviceId: session.deviceId }));
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'result' && message.type !== 'batch_result' && message.type !== 'heartbeat') { ws.send(JSON.stringify({ type: 'error', error: 'client_message_not_allowed' })); return; }
      const device = devices.get(session.deviceId); if (device) { device.lastSeen = Date.now(); devices.set(session.deviceId, device); }
      if (message.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat_ack', at: Date.now() }));
    } catch { ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' })); }
  });
  ws.on('close', () => { sockets.delete(session.sessionId); frames.delete(session.sessionId); liveSignals.delete(session.sessionId); session.active = false; sessions.set(token, session); const device = devices.get(session.deviceId); if (device?.sessionId === session.sessionId) devices.delete(session.deviceId); });
});

app.post('/v1/sessions/:sessionId/commands', (req, res) => {
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY) return json(res, 401, { error: 'unauthorized' });
  const { action, payload = {} } = req.body || {};
  if (!allowedActions.has(action)) return json(res, 403, { error: 'action_not_allowed', allowedActions: [...allowedActions] });
  const session = [...sessions.values()].find(item => item.sessionId === req.params.sessionId && item.active);
  if (!session) return json(res, 404, { error: 'active_session_not_found' });
  const ws = sockets.get(session.sessionId);
  if (!ws || ws.readyState !== 1) return json(res, 409, { error: 'device_websocket_not_connected' });
  const commandId = crypto.randomUUID();
  ws.send(JSON.stringify({ type: 'command', commandId, action, payload }));
  return json(res, 202, { accepted: true, commandId, action, payload });
});

app.post('/v1/sessions/:sessionId/agent/plan', async (req, res) => {
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY) return json(res, 401, { error: 'unauthorized' });
  const session = [...sessions.values()].find(item => item.sessionId === req.params.sessionId && item.active);
  if (!session) return json(res, 404, { error: 'active_session_not_found' });
  try { return json(res, 200, await planTask(req.body || {})); } catch (error) { return json(res, 502, { ok: false, error: 'agent_unavailable' }); }
});

app.post('/v1/sessions/:sessionId/agent/execute', (req, res) => {
  if (req.header('x-control-key') !== process.env.CONTROL_API_KEY) return json(res, 401, { error: 'unauthorized' });
  const { taskId = crypto.randomUUID(), actions = [], confirmed = false } = req.body || {};
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 3) return json(res, 400, { error: 'invalid_action_batch' });
  const sensitive = actions.some(item => item.action === 'type_text');
  if (sensitive && confirmed !== true) return json(res, 409, { error: 'confirmation_required', taskId, actions });
  const session = [...sessions.values()].find(item => item.sessionId === req.params.sessionId && item.active);
  const ws = session && sockets.get(session.sessionId);
  if (!session || !ws || ws.readyState !== 1) return json(res, 409, { error: 'device_websocket_not_connected' });
  const batchId = crypto.randomUUID();
  ws.send(JSON.stringify({ type: 'action_batch', taskId, batchId, actions, requireFrameAfter: true }));
  return json(res, 202, { accepted: true, taskId, batchId });
});

server.listen(port, '0.0.0.0', () => console.log(`authorized backend listening on ${port}`));
