// Claude 중계: 앱의 Anthropic SDK가 baseURL을 여기로 두고 부르면, 로그인 확인 후 서버 키로 그대로 전달해요.
// 요청·응답(스트리밍 포함)은 손대지 않고 통과시키고, 사용량만 ai_calls에 남겨요.
import { waitUntil } from '@vercel/functions';
import { cors, json, whoIs, usedToday, logCall, limitOf } from '../../_lib.js';

export const config = { maxDuration: 300 };
const err = (req, status, type, message) => json(req, status, { type: 'error', error: { type, message } });

export function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }); }

export async function POST(req) {
  try { return await relay(req); }
  catch (e) { console.error('claude relay failed:', e?.name || 'Error'); return err(req, 500, 'api_error', '서버 함수에서 오류가 났어요. 잠시 뒤 다시 시도해 주세요'); }
}
async function relay(req) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return err(req, 503, 'api_error', '서버에 Claude 키가 아직 없어요');
  // Claude 구독 로그인 토큰(sk-ant-oat…)·관리자 키는 API 호출에 못 써요. 그 밖의 형식은 Claude가 직접 판단
  if (/^sk-ant-(oat|ort|admin)/.test(key)) return err(req, 503, 'api_error', '서버 Claude 키가 API 키가 아니에요. console.anthropic.com → API Keys에서 만든 키를 넣어 주세요');
  // 앱은 x-api-key 자리에 로그인 토큰을 넣어 보내요
  const user = await whoIs(req.headers.get('x-api-key') || (req.headers.get('authorization') || '').replace(/^Bearer /, ''));
  if (!user) return err(req, 401, 'authentication_error', '로그인이 필요해요. 설정 › 계정에서 다시 로그인해 주세요');
  const limit = limitOf('AI_DAILY_LIMIT', 100);
  if ((await usedToday(user.id, 'claude%')) >= limit) return err(req, 429, 'rate_limit_error', `오늘 AI 사용 한도(${limit}번)를 다 썼어요. 내일 다시 써 주세요`);

  const body = await req.text();
  let model = '';
  try { model = JSON.parse(body).model || ''; } catch { return err(req, 400, 'invalid_request_error', '요청을 읽지 못했어요'); }
  const url = new URL(req.url);
  const headers = { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-version': req.headers.get('anthropic-version') || '2023-06-01' };
  const beta = req.headers.get('anthropic-beta');
  if (beta) headers['anthropic-beta'] = beta;
  let up;
  try { up = await fetch(`https://api.anthropic.com/v1/messages${url.search}`, { method: 'POST', headers, body }); }
  catch (e) { waitUntil(logCall({ user_id: user.id, kind: 'claude', model, ok: false })); console.error('claude fetch failed:', e?.name || 'Error'); return err(req, 502, 'api_error', /header/i.test(String(e?.message)) ? '서버 Claude 키 형식이 맞지 않아요. Vercel 환경 변수의 ANTHROPIC_API_KEY를 확인해 주세요' : 'Claude에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요'); }

  const out = new Headers(cors(req));
  for (const h of ['content-type', 'request-id', 'retry-after']) { const v = up.headers.get(h); if (v) out.set(h, v); }
  const row = { user_id: user.id, kind: 'claude', model, ok: up.ok };
  const stream = (up.headers.get('content-type') || '').includes('event-stream');
  if (!up.body) { waitUntil(logCall(row)); return new Response(null, { status: up.status, headers: out }); }
  const [toApp, toLog] = up.body.tee();
  waitUntil((async () => {
    try {
      const text = await new Response(toLog).text();
      if (stream) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'message_start') { row.tokens_in = ev.message?.usage?.input_tokens; row.model = ev.message?.model || row.model; }
          if (ev.type === 'message_delta' && ev.usage) row.tokens_out = ev.usage.output_tokens;
        }
      } else {
        const j = JSON.parse(text);
        row.tokens_in = j.usage?.input_tokens; row.tokens_out = j.usage?.output_tokens; row.model = j.model || row.model;
      }
    } catch { /* 기록용 파싱 실패는 무시 */ }
    await logCall(row);
  })());
  return new Response(toApp, { status: up.status, headers: out });
}
