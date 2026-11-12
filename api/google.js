// 구글 Places(New)·Routes 중계: 로그인 확인 후 서버 키를 붙여 전달해요. 허용한 주소만 통과.
import { waitUntil } from '@vercel/functions';
import { cors, json, whoIs, usedToday, logCall, limitOf } from './_lib.js';

const ALLOW = [
  [/^places:(searchNearby|searchText|autocomplete)$/, 'https://places.googleapis.com/v1/', 'google.places'],
  [/^places\/[A-Za-z0-9_-]+$/, 'https://places.googleapis.com/v1/', 'google.places'],
  [/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+\/media$/, 'https://places.googleapis.com/v1/', 'google.photo'],
  [/^directions\/v2:computeRoutes$/, 'https://routes.googleapis.com/', 'google.routes'],
];
export function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }); }
async function handle(req) {
  const key = (process.env.GOOGLE_API_KEY || '').trim();
  if (!key) return json(req, 503, { error: { message: '서버에 구글 키가 아직 없어요' } });
  const user = await whoIs((req.headers.get('authorization') || '').replace(/^Bearer /, ''));
  if (!user) return json(req, 401, { error: { message: '로그인이 필요해요' } });
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || '';
  const hit = ALLOW.find(([re]) => re.test(path));
  if (!hit) return json(req, 400, { error: { message: '허용되지 않은 구글 주소예요' } });
  const limit = limitOf('GOOGLE_DAILY_LIMIT', 2000);
  if ((await usedToday(user.id, 'google%')) >= limit) return json(req, 429, { error: { message: `오늘 구글 사용 한도(${limit}번)를 다 썼어요` } });
  const q = new URLSearchParams(url.searchParams);
  q.delete('path'); q.delete('key');
  const headers = { 'X-Goog-Api-Key': key };
  const mask = req.headers.get('x-goog-fieldmask');
  if (mask) headers['X-Goog-FieldMask'] = mask;
  const body = req.method === 'POST' ? await req.text() : undefined;
  if (body) headers['Content-Type'] = 'application/json';
  const up = await fetch(`${hit[1]}${path}${q.toString() ? '?' + q : ''}`, { method: req.method, headers, body });
  const text = await up.text();
  waitUntil(logCall({ user_id: user.id, kind: hit[2], ok: up.ok }));
  return new Response(text, { status: up.status, headers: { ...cors(req), 'content-type': up.headers.get('content-type') || 'application/json' } });
}
export const GET = handle;
export const POST = handle;
