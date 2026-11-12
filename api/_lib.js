// 서버 함수 공통: 로그인 확인, 사용 기록, 하루 한도, CORS
// 키는 모두 Vercel 환경 변수에만 있어요 (코드·GitHub에 없음)
//   ANTHROPIC_API_KEY   Claude 키
//   GOOGLE_API_KEY      구글 Places·Routes 키 (웹사이트 제한 없이, API 제한만)
//   SUPABASE_SECRET_KEY sb_secret_… (사용 기록 저장·한도 계산용)
//   AI_DAILY_LIMIT      한 사람 하루 Claude 호출 수 (기본 100)
//   GOOGLE_DAILY_LIMIT  한 사람 하루 구글 호출 수 (기본 2000, 장소 전체 다시 채우기 한 번에 약 700)
export const SB_URL = 'https://fdyqogadwtaqfthhnpyj.supabase.co';
export const SB_PUBLIC = 'sb_publishable_P4QnIKfw07z9zip5cbnDSw_Kx21KkPF';
const ORIGINS = ['https://woo72da.github.io', 'https://tokyo-trip-snowy.vercel.app', 'http://localhost:8770'];

export function cors(req) {
  const o = req.headers.get('origin') || '';
  const ok = ORIGINS.includes(o) || /^https:\/\/tokyo-trip-[a-z0-9-]+\.vercel\.app$/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : ORIGINS[1],
    'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') || 'authorization, x-api-key, content-type, anthropic-version, anthropic-beta, x-goog-fieldmask, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-retry-count, x-stainless-runtime, x-stainless-runtime-version, x-stainless-timeout, anthropic-dangerous-direct-browser-access',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
export const json = (req, status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'content-type': 'application/json' } });

// 앱이 보낸 Supabase 로그인 토큰으로 누구인지 확인
export async function whoIs(token) {
  if (!token || token.length < 20) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_PUBLIC, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? u : null;
}

const secret = () => process.env.SUPABASE_SECRET_KEY || '';
const tokyoDayStart = () => {
  const d = new Date(Date.now() + 9 * 3600e3);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * 3600e3).toISOString();
};
// 오늘(도쿄 시각) 이 사람이 쓴 횟수
export async function usedToday(userId, kindLike) {
  if (!secret()) return 0;
  const q = `${SB_URL}/rest/v1/ai_calls?select=id&user_id=eq.${userId}&kind=like.${encodeURIComponent(kindLike)}&at=gte.${encodeURIComponent(tokyoDayStart())}`;
  const r = await fetch(q, { headers: { apikey: secret(), Prefer: 'count=exact', Range: '0-0' } });
  const total = Number((r.headers.get('content-range') || '').split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}
export async function logCall(row) {
  if (!secret()) return;
  try {
    await fetch(`${SB_URL}/rest/v1/ai_calls`, {
      method: 'POST',
      headers: { apikey: secret(), 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch { /* 기록 실패는 사용자 요청을 막지 않음 */ }
}
export const limitOf = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
