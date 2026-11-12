// 서버에 어떤 키가 들어 있는지만 알려 줘요 (키 값은 절대 내보내지 않음)
import { cors, json } from './_lib.js';
export function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }); }
export function GET(req) {
  return json(req, 200, {
    claude: !!process.env.ANTHROPIC_API_KEY,
    google: !!process.env.GOOGLE_API_KEY,
    log: !!process.env.SUPABASE_SECRET_KEY,
  });
}
