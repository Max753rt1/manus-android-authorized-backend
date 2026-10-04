import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 10000);
const pairingCode = process.env.PAIRING_CODE;
const sessions = new Map();
const devices = new Map();
const sockets = new Map();
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
  return json(res, 200, { devices: [...devices.values()].map(({ deviceId, deviceName, lastSeen, sessionId }) => ({ deviceId, deviceName, lastSeen, sessionId })) });
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
      if (message.type !== 'result' && message.type !== 'heartbeat') { ws.send(JSON.stringify({ type: 'error', error: 'client_message_not_allowed' })); return; }
      if (message.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat_ack', at: Date.now() }));
    } catch { ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' })); }
  });
  ws.on('close', () => { sockets.delete(session.sessionId); session.active = false; sessions.set(token, session); });
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

server.listen(port, '0.0.0.0', () => console.log(`authorized backend listening on ${port}`));
