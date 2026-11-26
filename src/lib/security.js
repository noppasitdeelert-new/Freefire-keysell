const enc = new TextEncoder();
const dec = new TextDecoder();

export class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ---------- encoding helpers ---------- */

export function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(data)));
  return b64url(new Uint8Array(sig));
}

export function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function hmacVerify(secret, data, signature) {
  const expected = await hmacSign(secret, data);
  return safeEqual(expected, signature);
}

/* ---------- passwords ---------- */

export async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    // Cloudflare Workers รองรับ PBKDF2 สูงสุด 100,000 รอบ
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- request helpers ---------- */

export function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(data), { status, headers });
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * อ่าน JSON แบบจำกัดขนาด — กัน payload overload
 * (ตัดทิ้งทันทีถ้าใหญ่เกิน, ฟิลด์มากเกิน, หรือไม่ใช่ object)
 */
export async function readJson(request, maxBytes = 8192) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด');
  }
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/json')) {
    throw new HttpError(415, 'ต้องส่งข้อมูลแบบ JSON');
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError(413, 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด');
  }
  if (!text) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง');
  }
  if (Object.keys(data).length > 24) {
    throw new HttpError(400, 'จำนวนฟิลด์มากเกินกำหนด');
  }
  return data;
}

/* ---------- validation ---------- */

export function str(value, { label = 'ข้อมูล', min = 0, max = 200, pattern = null, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `กรุณากรอก${label}`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(400, `${label}ไม่ถูกต้อง`);
  }
  const out = String(value).trim();
  if (required && out.length < Math.max(1, min)) throw new HttpError(400, `${label}ต้องมีอย่างน้อย ${Math.max(1, min)} ตัวอักษร`);
  if (!required && out.length === 0) return '';
  if (out.length > max) throw new HttpError(400, `${label}ต้องไม่เกิน ${max} ตัวอักษร`);
  if (pattern && !pattern.test(out)) throw new HttpError(400, `${label}ไม่ถูกต้อง`);
  return out;
}

export function num(value, { label = 'จำนวน', min = 0, max = 1e9, integer = false } = {}) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) throw new HttpError(400, `${label}ไม่ถูกต้อง`);
  if (n < min || n > max) throw new HttpError(400, `${label}ต้องอยู่ระหว่าง ${min} - ${max}`);
  if (integer && !Number.isInteger(n)) throw new HttpError(400, `${label}ต้องเป็นจำนวนเต็ม`);
  return n;
}

export function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

/* ---------- rate limiting (Cloudflare edge protection) ---------- */

export async function rateLimit(db, bucket, limit, windowMs) {
  const now = Date.now();
  const row = await db
    .prepare('SELECT count, reset_at FROM rate_limits WHERE bucket = ?')
    .bind(bucket)
    .first();
  if (!row || Number(row.reset_at) <= now) {
    await db
      .prepare(
        'INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?) ' +
          'ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at',
      )
      .bind(bucket, now + windowMs)
      .run();
    return { ok: true, remaining: limit - 1 };
  }
  if (Number(row.count) >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((Number(row.reset_at) - now) / 1000)) };
  }
  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?').bind(bucket).run();
  return { ok: true, remaining: limit - Number(row.count) - 1 };
}

export async function enforceRate(db, bucket, limit, windowMs) {
  const result = await rateLimit(db, bucket, limit, windowMs);
  if (!result.ok) {
    throw new HttpError(429, `ทำรายการเร็วเกินไป กรุณาลองใหม่ใน ${result.retryAfter} วินาที`, {
      retryAfter: result.retryAfter,
    });
  }
}

/* ---------- captcha (server-side, กันบอทหน้า สมัคร/ล็อกอิน) ---------- */

export async function makeCaptcha(db) {
  const a = 2 + Math.floor(Math.random() * 9);
  const b = 2 + Math.floor(Math.random() * 9);
  const useMinus = a > b && Math.random() < 0.35;
  const question = useMinus ? `${a} - ${b}` : `${a} + ${b}`;
  const answer = String(useMinus ? a - b : a + b);
  const id = randomHex(18);
  const expiresAt = Date.now() + 5 * 60 * 1000;
  await db
    .prepare('INSERT INTO captchas (id, answer, expires_at, used) VALUES (?, ?, ?, 0)')
    .bind(id, answer, expiresAt)
    .run();
  return { token: id, question: `${question} = ?` };
}

export async function checkCaptcha(db, token, answer) {
  const id = str(token, { label: 'แคปช่า', min: 6, max: 64 });
  const given = str(answer, { label: 'คำตอบแคปช่า', min: 1, max: 8 });
  const row = await db
    .prepare('SELECT id, answer, expires_at, used FROM captchas WHERE id = ?')
    .bind(id)
    .first();
  if (!row) throw new HttpError(400, 'แคปช่าไม่ถูกต้อง กรุณาขอใหม่');
  if (Number(row.used) === 1) throw new HttpError(400, 'แคปช่านี้ถูกใช้ไปแล้ว กรุณาขอใหม่');
  if (Number(row.expires_at) < Date.now()) throw new HttpError(400, 'แคปช่าหมดอายุ กรุณาขอใหม่');
  await db.prepare('UPDATE captchas SET used = 1 WHERE id = ?').bind(id).run();
  if (!safeEqual(String(row.answer), given)) {
    throw new HttpError(400, 'คำตอบแคปช่าไม่ถูกต้อง');
  }
}

/* ---------- gate (ยืนยันว่าไม่ใช่บอทก่อนเข้าเว็บ) ---------- */

export const GATE_COOKIE = 'fk_gate';
export const GATE_HOURS = 12;

export async function createGateToken(secret, hours = GATE_HOURS) {
  const exp = Date.now() + hours * 3600 * 1000;
  const body = String(exp);
  const sig = await hmacSign(secret, `gate:${body}`);
  return `${body}.${sig}`;
}

export async function verifyGateToken(secret, token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const body = token.slice(0, idx);
  if (!(await hmacVerify(secret, `gate:${body}`, token.slice(idx + 1)))) return false;
  const exp = Number(body);
  return Number.isFinite(exp) && exp > Date.now();
}

export function gateCookie(token, secure) {
  const parts = [
    `${GATE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + String(GATE_HOURS * 3600),
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ---------- sessions ---------- */

export const SESSION_COOKIE = 'fk_session';

export async function createSession(secret, uid) {
  const payload = { uid: Number(uid), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

export async function readSession(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!(await hmacVerify(secret, body, sig))) return null;
  try {
    const payload = JSON.parse(dec.decode(unb64url(body)));
    if (!payload || !payload.uid || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookie(secretlessToken, secure) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(secretlessToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + String(7 * 24 * 60 * 60),
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
