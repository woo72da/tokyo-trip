// 서버에 어떤 키가 들어 있는지, Claude 키가 실제로 통하는지만 알려 줘요 (키 값은 절대 내보내지 않음)
import { cors, json } from './_lib.js';
export function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }); }
// 키가 통하는지: 모델 목록 조회(무료)로 확인, 5분 동안 기억
let cache = { at: 0, key: '', ok: null, why: '' };
async function claudeCheck(key) {
  if (cache.key === key && Date.now() - cache.at < 300000) return cache;
  let ok = false, why = '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    ok = r.ok;
    if (!ok) why = r.status === 401 ? '키가 맞지 않아요' : r.status === 403 ? '이 키로는 쓸 수 없어요' : `Claude 응답 ${r.status}`;
  } catch { why = 'Claude에 연결하지 못했어요'; }
  cache = { at: Date.now(), key, ok, why };
  return cache;
}
export async function GET(req) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  const bad = /^sk-ant-(oat|ort|admin)/.test(key);
  const chk = key && !bad ? await claudeCheck(key) : { ok: false, why: key ? 'API 키가 아니에요' : '' };
  return json(req, 200, {
    claude: !!chk.ok,
    claudeWhy: chk.ok ? '' : chk.why,
    google: !!(process.env.GOOGLE_API_KEY || '').trim(),
    log: !!process.env.SUPABASE_SECRET_KEY,
  });
}
