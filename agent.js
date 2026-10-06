const aiBase = (process.env.AI_BASE_URL || '').replace(/\/$/, '');
const aiKey = process.env.AI_API_KEY || '';
const aiModel = process.env.AI_MODEL_VISION || process.env.AI_MODEL_PLANNER || 'gemini-2.5-flash';

const safety = (actions = []) => actions.some(a => ['send_message', 'publish', 'purchase', 'trade', 'install_apk', 'root'].includes(a.action) || a.action === 'type_text');

export async function planTask({ instruction, uiText = '', imageBase64 = '' }) {
  if (!aiBase || !aiKey) return { ok: false, error: 'ai_not_configured' };
  const prompt = `Eres un agente de interfaz Android autorizado. Devuelve SOLO JSON con {"summary":string,"actions":[{"id":string,"action":"tap|swipe|type_text|wait|back|home","x":number,"y":number,"x1":number,"y1":number,"x2":number,"y2":number,"duration":number,"text":string,"ms":number}],"needsConfirmation":boolean}. Máximo 3 acciones. Nunca ejecutes root, pagos, trading, publicación ni envío de mensajes sin needsConfirmation=true. Orden: ${instruction}. Texto accesibilidad: ${uiText}`;
  const content = [{ type: 'text', text: prompt }];
  if (imageBase64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } });
  const response = await fetch(`${aiBase}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${aiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: aiModel, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }) });
  if (!response.ok) return { ok: false, error: `ai_http_${response.status}` };
  const data = await response.json();
  let result;
  try { result = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch { return { ok: false, error: 'ai_invalid_json' }; }
  result.actions = Array.isArray(result.actions) ? result.actions.slice(0, 3) : [];
  result.needsConfirmation = Boolean(result.needsConfirmation || safety(result.actions));
  return { ok: true, ...result };
}
