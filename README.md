# Manus Android Authorized Backend

Backend inicial para una app Android que controla un dispositivo propio o explícitamente autorizado.

## Endpoints

- `GET /health` — salud pública.
- `POST /v1/pair` — intercambia el código de emparejamiento por un token de sesión.
- `GET /v1/devices` — lista dispositivos, requiere `X-Control-Key`.
- `POST /v1/sessions/:sessionId/commands` — acepta únicamente `open_app`, `get_status`, `request_screenshot` y `stop_session`, requiere `X-Control-Key`.
- `POST /v1/sessions/:sessionId/stop` — revoca una sesión, requiere `X-Control-Key`.
- `WSS /v1/control` — canal del dispositivo con `Authorization: Bearer <token>`.

## Variables Render

- `PAIRING_CODE`: código largo y aleatorio que se escribe en la app.
- `CONTROL_API_KEY`: clave privada solo para el orquestador; nunca se coloca en la APK.

El servicio es deliberadamente limitado: no implementa apagado, reinicio, comandos root ni publicación en redes. La app debe mostrar y solicitar los permisos Android correspondientes.

## Desarrollo local

```bash
npm install
PAIRING_CODE='cambia-este-codigo' CONTROL_API_KEY='cambia-esta-clave' npm start
```

## Despliegue

Render: runtime Node, build `npm ci`, start `npm start`, región Oregon, plan inicial free.
