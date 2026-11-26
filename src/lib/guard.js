import { HttpError } from './security.js';

/**
 * ระบบป้องกันคำขอจำนวนมาก (DDoS / flood / bot spam) — สองชั้น
 *
 *  ชั้น 1: ตัวนับในหน่วยความจำของ isolate (เร็ว ไม่แตะฐานข้อมูล)
 *          - burst window 5 วินาที  และ window 60 วินาที ต่อ IP
 *  ชั้น 2: ตาราง ip_bans ใน D1 (อยู่ถาวร ข้าม isolate / ข้าม colo)
 *          - ผู้ที่ยิงถี่เกินซ้ำ ๆ จะถูกแบนอัตโนมัติแบบทวีคูณ
 *
 *  ทุกคำขอที่เข้า /api/* จะผ่านที่นี่ก่อนทำงานจริง
 */

const BURST_WINDOW_MS = 5_000;
const BURST_LIMIT = 20;
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 120;
const VIOLATION_WINDOW_MS = 10 * 60_000;
const BAN_THRESHOLD = 3;
const BASE_BAN_MS = 5 * 60_000;
const MAX_BAN_MS = 60 * 60_000;
const MAX_TRACKED_IPS = 4000;
const BAN_CACHE_MS = 30_000;
const MAX_URL_LENGTH = 2048;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * เส้นทางที่หน้าเว็บเรียกซ้ำเองเป็นระยะ (polling สถานะเรียลไทม์)
 * แยกโควตาออกจากการท่องเว็บปกติ และไม่สะสมโทษแบน
 * เพื่อไม่ให้ผู้ใช้จริงที่เปิดหลายแท็บ/หลายอุปกรณ์ถูกแบนจนเว็บใช้งานไม่ได้
 */
const POLL_PATHS = new Set(['/api/live']);
const POLL_BURST_WINDOW_MS = 5_000;
const POLL_BURST_LIMIT = 60;
const POLL_WINDOW_MS = 60_000;
const POLL_WINDOW_LIMIT = 300;

const buckets = new Map();
const banCache = new Map();

function prune(list, cutoff) {
  let index = 0;
  while (index < list.length && list[index] < cutoff) index += 1;
  if (index) list.splice(0, index);
}

function sweep() {
  const now = Date.now();
  for (const [ip, entry] of buckets) {
    if (now - entry.last > WINDOW_MS * 3) buckets.delete(ip);
  }
}

function track(ip) {
  let entry = buckets.get(ip);
  if (!entry) {
    if (buckets.size >= MAX_TRACKED_IPS) {
      sweep();
      if (buckets.size >= MAX_TRACKED_IPS) buckets.clear();
    }
    entry = { hits: [], pollHits: [], violations: [], last: 0 };
    buckets.set(ip, entry);
  }
  return entry;
}

function pathnameOf(url) {
  try {
    return new URL(String(url || ''), 'https://local.invalid').pathname;
  } catch {
    return '';
  }
}

function countRecent(hits, cutoff) {
  let total = 0;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    if (hits[i] < cutoff) break;
    total += 1;
  }
  return total;
}

function banError(until, now, message) {
  return new HttpError(429, message || 'ตรวจพบการส่งคำขอผิดปกติ ระบบระงับการเชื่อมต่อชั่วคราว', {
    retryAfter: Math.max(1, Math.ceil((until - now) / 1000)),
    blocked: true,
  });
}

async function bannedUntilFor(db, ip, now) {
  const cached = banCache.get(ip);
  if (cached && now - cached.checkedAt < BAN_CACHE_MS) {
    return cached.until > now ? cached.until : 0;
  }
  let until = 0;
  try {
    const row = await db.prepare('SELECT banned_until FROM ip_bans WHERE ip = ?').bind(ip).first();
    if (row) until = Number(row.banned_until) || 0;
  } catch {
    /* ถ้าตารางยังไม่พร้อม ปล่อยผ่านแล้วให้ชั้นหน่วยความจำทำงานแทน */
    until = 0;
  }
  banCache.set(ip, { until, checkedAt: now });
  if (banCache.size > MAX_TRACKED_IPS) banCache.clear();
  return until > now ? until : 0;
}

async function persistBan(db, ip, until, hits) {
  banCache.set(ip, { until, checkedAt: Date.now() });
  try {
    await db
      .prepare(
        `INSERT INTO ip_bans (ip, reason, hits, banned_until) VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, hits = excluded.hits, banned_until = excluded.banned_until`,
      )
      .bind(ip, 'ยิงคำขอถี่เกินกำหนด', hits, until)
      .run();
    await db
      .prepare('INSERT INTO audit_logs (actor_name, action, detail) VALUES (?, ?, ?)')
      .bind('system', 'security.ban', `${ip} ถูกระงับถึง ${new Date(until).toISOString()} (ครั้งที่ ${hits})`)
      .run();
  } catch {
    /* บันทึกไม่ได้ก็ยังกันที่ชั้นหน่วยความจำ */
  }
}

/**
 * ตรวจทุกคำขอ API — โยน HttpError(429) เมื่อควรถูกจำกัด/ระงับ
 */
export async function guardRequest({ db, ip, method, url }) {
  const verb = String(method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(verb)) throw new HttpError(405, 'ไม่อนุญาตให้ใช้วิธีนี้');
  if (String(url || '').length > MAX_URL_LENGTH) throw new HttpError(414, 'ที่อยู่คำขอยาวเกินกำหนด');

  const now = Date.now();
  const bannedUntil = await bannedUntilFor(db, ip, now);
  if (bannedUntil) throw banError(bannedUntil, now);

  const entry = track(ip);
  entry.last = now;
  prune(entry.violations, now - VIOLATION_WINDOW_MS);

  // polling ของหน้าเว็บ: แยกโควตา ไม่นับเป็นการยิงถี่ และไม่นำไปสู่การแบน IP
  if (POLL_PATHS.has(pathnameOf(url))) {
    prune(entry.pollHits, now - POLL_WINDOW_MS);
    entry.pollHits.push(now);
    const pollBurst = countRecent(entry.pollHits, now - POLL_BURST_WINDOW_MS);
    if (pollBurst <= POLL_BURST_LIMIT && entry.pollHits.length <= POLL_WINDOW_LIMIT) return;
    throw new HttpError(429, 'ระบบกำลังอัปเดตข้อมูล กรุณารอสักครู่แล้วลองใหม่', { retryAfter: 5 });
  }

  prune(entry.hits, now - WINDOW_MS);
  entry.hits.push(now);

  const burst = countRecent(entry.hits, now - BURST_WINDOW_MS);
  if (burst <= BURST_LIMIT && entry.hits.length <= WINDOW_LIMIT) return;

  entry.violations.push(now);
  const level = entry.violations.length;
  if (level < BAN_THRESHOLD) {
    throw new HttpError(429, 'ส่งคำขอถี่เกินกำหนด กรุณารอสักครู่แล้วลองใหม่', {
      retryAfter: Math.ceil(BURST_WINDOW_MS / 1000),
    });
  }

  const penalty = Math.min(BASE_BAN_MS * 2 ** (level - BAN_THRESHOLD), MAX_BAN_MS);
  const until = now + penalty;
  await persistBan(db, ip, until, level);
  entry.hits.length = 0;
  throw banError(until, now);
}

/** ใช้แสดงสถานะการป้องกันในหน้าหลังบ้าน */
export async function securitySummary(db) {
  const now = Date.now();
  const [bans, recent] = await db.batch([
    db.prepare('SELECT COUNT(*) AS total FROM ip_bans WHERE banned_until > ?').bind(now),
    db.prepare(
      "SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'security.ban' AND created_at >= datetime('now', '-1 day')",
    ),
  ]);
  return {
    activeBans: Number(bans.results[0]?.total || 0),
    bans24h: Number(recent.results[0]?.total || 0),
    limits: {
      burst: `${BURST_LIMIT} คำขอ / ${BURST_WINDOW_MS / 1000} วินาที`,
      window: `${WINDOW_LIMIT} คำขอ / ${WINDOW_MS / 60000} นาที`,
      banAfter: BAN_THRESHOLD,
    },
  };
}
