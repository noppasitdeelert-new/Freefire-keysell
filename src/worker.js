import {
  HttpError,
  json,
  parseCookies,
  readJson,
  str,
  num,
  money,
  randomHex,
  hashPassword,
  safeEqual,
  createSession,
  readSession,
  sessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  enforceRate,
  rateLimit,
  makeCaptcha,
  checkCaptcha,
  sha256Hex,
  GATE_COOKIE,
  createGateToken,
  verifyGateToken,
  gateCookie,
} from './lib/security.js';
import {
  initDb,
  audit,
  syncStock,
  ROLES,
  STAFF_ROLES,
  BRAND,
  BRAND_FULL,
  DEALER_DISCOUNT,
  FEE_PERCENT,
  TICKET_PHONE,
  DISCORD_URL,
  RESELLER_FEE,
  RESELLER_WEEKLY_TARGET,
  RESELLER_MONTHLY_TARGET,
  RESELLER_TRIAL_DAYS,
} from './lib/db.js';
import { guardRequest, securitySummary } from './lib/guard.js';
import { requirePermission, permissionsFor } from './lib/perms.js';
import { awardSignupReward, awardFirstPurchaseReward, findReferrerByCode, normalizeReferralCode } from './lib/referral.js';
import { sendEmail, emailConfig } from './lib/email.js';
import { recordFraud } from './lib/fraud.js';
import { toSatang, fromSatang, splitFee, thb } from './lib/money.js';
import { createUltimate } from './ultimate.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const ROLE_KEYS = Object.keys(ROLES);
const STAFF_SET = new Set(STAFF_ROLES);
const STAFF_RANK = ROLES.support.rank;
const DEALER_RATE = 1 - DEALER_DISCOUNT;

function roleRank(role) {
  return ROLES[role] ? ROLES[role].rank : 99;
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'local'
  );
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    roleLabel: ROLES[user.role]?.label || user.role,
    rank: roleRank(user.role),
    balance: money(user.balance),
    points: Number(user.points || 0),
    locale: user.locale || 'th',
    email: user.email || '',
    restricted: Number(user.restricted) === 1,
    isRoot: Number(user.is_root) === 1,
    contact: user.contact,
    createdAt: user.created_at,
  };
}

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบก่อนทำรายการ');
  return ctx.user;
}

async function requireStaff(ctx) {
  const user = requireUser(ctx);
  if (!STAFF_SET.has(user.role)) {
    await recordFraud(ctx.db, {
      userId: user.id,
      type: 'admin_unauthorized',
      risk: 'high',
      description: `ผู้ใช้ ${user.username} (${user.role}) พยายามเรียก Admin API ${ctx.url ? ctx.url.pathname : ''}`,
      evidence: { path: ctx.url ? ctx.url.pathname : '', role: user.role },
      ip: ctx.ip || '',
    });
    throw new HttpError(403, 'เฉพาะทีมงานเท่านั้น');
  }
  return user;
}

function requireOwner(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'owner') throw new HttpError(403, 'เฉพาะ Owner เท่านั้นที่จัดการยศได้');
  return user;
}

async function getSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const row of rows.results) map[row.key] = row.value;
  return map;
}

function priceFor(product, role) {
  const base = money(product.price);
  if (role === 'dealer') return money(base * DEALER_RATE);
  return base;
}

// ภาพสินค้าแยกตามชื่อ (สินค้าที่แอดมินเพิ่มใหม่จะใช้แบนเนอร์ VEXIS แทนโดยอัตโนมัติ)
const PRODUCT_ART = [
  [/phantom/i, '/img/product-phantom.svg'],
  [/rezzx/i, '/img/product-rezzx.svg'],
  [/aim\s*hack|aimhack/i, '/img/product-aimhack.svg'],
];

function productImage(name) {
  const text = String(name || '');
  for (const [pattern, path] of PRODUCT_ART) if (pattern.test(text)) return path;
  return '/img/vexis-banner.svg';
}

function productView(product, role) {
  const listPrice = money(product.price);
  const yourPrice = priceFor(product, role);
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    categoryId: product.category_id,
    categoryName: product.category_name || '',
    price: listPrice,
    yourPrice,
    stock: Number(product.stock),
    soldOut: Number(product.stock) <= 0,
    duration: product.duration || '',
    image: productImage(product.name),
    soldCount: Number(product.sold_count || 0),
    dealerPrice: money(listPrice * DEALER_RATE),
    active: Number(product.active) === 1,
  };
}

/* ------------------------------------------------------------------ */
/* ตัวแทน/ตัวขาย + API                                                 */
/* ------------------------------------------------------------------ */

function sqliteTime(value) {
  if (!value) return 0;
  const text = String(value);
  return Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`) || 0;
}

async function resellerSales(db, userId) {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN total ELSE 0 END), 0) AS weekly,
         COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN total ELSE 0 END), 0) AS monthly,
         COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS orders30
       FROM orders WHERE user_id = ?`,
    )
    .bind(userId)
    .first();
  return {
    weekly: money(row?.weekly || 0),
    monthly: money(row?.monthly || 0),
    orders30: Number(row?.orders30 || 0),
  };
}

/**
 * ตรวจสถานะตัวแทนอัตโนมัติ
 *  - ค้างค่าบริการ 30 บาท/เดือน → ระงับการใช้ API จนกว่าจะชำระ
 *  - ครบ 1 เดือนแล้วยอดขาย 30 วันต่ำกว่า 650 บาท → ปลดเป็น member
 */
async function evaluateReseller(db, user) {
  if (!user) return null;
  const profile = await db.prepare('SELECT * FROM reseller_profiles WHERE user_id = ?').bind(user.id).first();
  if (!profile) return null;
  if (profile.status !== 'active') return profile;

  const paidUntil = sqliteTime(profile.fee_paid_until);
  if (paidUntil && paidUntil < Date.now()) {
    await db
      .prepare("UPDATE reseller_profiles SET status = 'suspended', review_note = ? WHERE id = ?")
      .bind(`ค้างชำระค่าบริการรายเดือน ${RESELLER_FEE} บาท`, profile.id)
      .run();
    await audit(db, null, 'reseller.suspend', `${user.username} ค้างชำระค่าบริการรายเดือน`);
    return { ...profile, status: 'suspended', review_note: `ค้างชำระค่าบริการรายเดือน ${RESELLER_FEE} บาท` };
  }

  const startedAt = sqliteTime(profile.started_at);
  if (startedAt && Date.now() - startedAt >= RESELLER_TRIAL_DAYS * 86400000) {
    const stats = await resellerSales(db, user.id);
    if (stats.monthly < RESELLER_MONTHLY_TARGET) {
      const reason = `ยอดขาย 30 วัน ${stats.monthly} บาท ต่ำกว่าเป้า ${RESELLER_MONTHLY_TARGET} บาท`;
      await db.batch([
        db.prepare("UPDATE users SET role = 'member' WHERE id = ? AND role = 'dealer'").bind(user.id),
        db
          .prepare(
            "UPDATE reseller_profiles SET status = 'revoked', review_note = ?, reviewed_at = datetime('now') WHERE id = ?",
          )
          .bind(reason, profile.id),
        db.prepare('UPDATE api_keys SET revoked = 1 WHERE user_id = ?').bind(user.id),
      ]);
      await audit(db, null, 'reseller.revoke', `${user.username}: ${reason}`);
      return { ...profile, status: 'revoked', review_note: reason };
    }
  }
  return profile;
}

async function dealerFromApiKey(ctx) {
  const { db, request } = ctx;
  await enforceRate(db, `api:ip:${ctx.ip}`, 90, 60 * 1000);
  const header = request.headers.get('authorization') || '';
  const raw = (header.replace(/^Bearer\s+/i, '').trim() || (request.headers.get('x-api-key') || '').trim()).slice(0, 120);
  if (!raw) {
    throw new HttpError(401, 'ต้องส่ง API key ผ่าน header Authorization: Bearer <key> หรือ x-api-key');
  }
  const hash = await sha256Hex(raw);
  const key = await db
    .prepare('SELECT * FROM api_keys WHERE token_hash = ? AND revoked = 0')
    .bind(hash)
    .first();
  if (!key) throw new HttpError(401, 'API key ไม่ถูกต้องหรือถูกยกเลิกแล้ว');
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(key.user_id).first();
  if (!user) throw new HttpError(401, 'ไม่พบบัญชีเจ้าของ API key');
  if (user.role !== 'dealer') throw new HttpError(403, 'API นี้ใช้ได้เฉพาะยศตัวแทน/ตัวขายเท่านั้น');
  const profile = await evaluateReseller(db, user);
  if (!profile || profile.status !== 'active') {
    throw new HttpError(403, 'สถานะตัวแทนไม่พร้อมใช้งาน (รออนุมัติ/ค้างชำระ/ถูกปลด) — ตรวจสอบที่หน้าตัวแทน');
  }
  await enforceRate(db, `api:key:${key.id}`, 60, 60 * 1000);
  await db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").bind(key.id).run();
  ctx.apiKey = key;
  return user;
}

async function verifyHuman(ctx, body) {
  const { env, request } = ctx;
  if (env.TURNSTILE_SECRET_KEY) {
    const token = str(body.turnstileToken, { label: 'แคปช่า', min: 10, max: 4096 });
    const form = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: clientIp(request),
    });
    let data;
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: form,
      });
      data = await res.json();
    } catch {
      throw new HttpError(503, 'ตรวจสอบแคปช่าไม่สำเร็จ กรุณาลองใหม่');
    }
    if (!data || !data.success) throw new HttpError(400, 'ยืนยันแคปช่าไม่ผ่าน กรุณาลองใหม่');
    return;
  }
  await checkCaptcha(env.DB, body.captchaToken, body.captchaAnswer);
}

async function startSession(ctx, user, secure) {
  const token = await createSession(ctx.secret, user.id);
  return { token, cookie: sessionCookie(token, secure) };
}

function isSecureRequest(request) {
  return new URL(request.url).protocol === 'https:';
}

async function logStaff(ctx, action, detail) {
  await audit(ctx.env.DB, ctx.user, action, detail);
}

/**
 * บันทึกธุรกรรมกระเป๋า + ปรับยอดแบบ atomic
 * - idempotency_key เป็น UNIQUE → ซ้ำไม่ได้ แม้เรียกพร้อมกัน
 * - คำนวณเป็นสตางค์ทั้งหมด (ไม่มีความคลาดเคลื่อนจาก floating-point)
 */
async function creditWallet(db, { userId, amountSatang, kind, refType = '', refId = null, note = '', idempotencyKey, actorId = null }) {
  const satang = Math.round(Number(amountSatang) || 0);
  if (satang <= 0) throw new HttpError(400, 'ยอดเครดิตไม่ถูกต้อง');
  const amount = fromSatang(satang);
  const user = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new HttpError(404, 'ไม่พบผู้ใช้');
  const before = fromSatang(toSatang(user.balance));
  const after = fromSatang(toSatang(user.balance) + satang);

  let txId = null;
  try {
    const inserted = await db
      .prepare(
        `INSERT INTO wallet_transactions
           (user_id, kind, amount, balance_before, balance_after, ref_type, ref_id, note, idempotency_key, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, kind, amount, before, after, refType, refId, String(note).slice(0, 200), idempotencyKey, actorId)
      .run();
    txId = inserted.meta.last_row_id;
  } catch {
    // idempotency ซ้ำ → ไม่เพิ่มเครดิตซ้ำ
    return { credited: false, duplicate: true, balance: before };
  }

  const updated = await db
    .prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?')
    .bind(amount, userId)
    .run();
  if (Number(updated.meta.changes) !== 1) {
    await db.prepare('DELETE FROM wallet_transactions WHERE id = ?').bind(txId).run();
    throw new HttpError(500, 'อัปเดตยอดเครดิตไม่สำเร็จ กรุณาลองใหม่');
  }
  return { credited: true, txId, amount, before, after };
}

/* ------------------------------------------------------------------ */
/* public routes                                                       */
/* ------------------------------------------------------------------ */

async function health(ctx) {
  const debug = ctx.env.HEALTH_DEBUG === '1';
  const result = { ok: false, hasDb: Boolean(ctx.env.DB), hasAssets: Boolean(ctx.env.ASSETS) };
  if (!ctx.env.DB) return json({ ...result, error: 'DB binding missing' }, 500);
  try {
    await ctx.env.DB.prepare('SELECT 1 AS ok').first();
    await initDb(ctx.env);
    return json({ ...result, ok: true, feePercent: FEE_PERCENT });
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 500);
    return json({ ...result, ...(debug ? { error: message } : { error: 'database error' }) }, 500);
  }
}

async function getConfig(ctx) {
  // หน้าเว็บต้องเปิดได้เสมอ แม้ฐานข้อมูลสะดุดชั่วคราว
  let settings = {};
  try {
    settings = await getSettings(ctx.env.DB);
  } catch {
    settings = {};
  }
  // ข้อมูลรับเงิน (เบอร์รับซอง/บัญชีธนาคาร) แสดงเฉพาะผู้ที่เข้าสู่ระบบแล้วเท่านั้น
  const viewer = ctx.user;
  return json({
    brand: BRAND,
    storeName: settings.store_name || ctx.env.STORE_NAME || BRAND_FULL,
    tagline: settings.store_tagline || '',
    feePercent: FEE_PERCENT,
    discordUrl: DISCORD_URL,
    paymentPrivate: Boolean(viewer),
    ticketPhone: viewer ? TICKET_PHONE : '',
    bank: {
      name: viewer ? settings.bank_name || '' : '',
      account: viewer ? settings.bank_account || '' : '',
      holder: viewer ? settings.bank_holder || '' : '',
    },
    topupNote: viewer ? settings.topup_note || '' : '',
    turnstileSiteKey: ctx.env.TURNSTILE_SITE_KEY || '',
    roles: ROLE_KEYS.map((key) => ({ key, label: ROLES[key].label, rank: ROLES[key].rank })),
    dealerDiscount: Math.round(DEALER_DISCOUNT * 100),
    maintenance: settings.maintenance_mode === '1',
    maintenanceMessage: settings.maintenance_mode === '1' ? settings.maintenance_message || '' : '',
    emailConfigured: emailConfig(ctx.env).configured,
  });
}

async function getCaptcha(ctx) {
  await enforceRate(ctx.env.DB, `captcha:${clientIp(ctx.request)}`, 40, 60 * 1000);
  const captcha = await makeCaptcha(ctx.env.DB);
  return json(captcha);
}

/* ---------- ประตูยืนยันตัวตน (ไม่ใช่บอท) ---------- */

async function gateStatus(ctx) {
  const cookies = parseCookies(ctx.request.headers.get('cookie') || '');
  const verified = await verifyGateToken(ctx.secret, cookies[GATE_COOKIE]);
  return json({ verified, hours: 12 });
}

async function gateVerify(ctx) {
  const ip = clientIp(ctx.request);
  await enforceRate(ctx.env.DB, `gate:${ip}`, 20, 10 * 60 * 1000);
  const body = await readJson(ctx.request, 2048);
  await verifyHuman(ctx, body);
  const token = await createGateToken(ctx.secret);
  return json(
    { ok: true, verified: true, hours: 12 },
    200,
    { 'set-cookie': gateCookie(token, isSecureRequest(ctx.request)) },
  );
}

async function getStore(ctx) {
  const db = ctx.env.DB;
  const role = ctx.user ? ctx.user.role : 'member';
  const [cats, products] = await db.batch([
    db.prepare('SELECT id, name, description FROM categories ORDER BY sort_order ASC, id ASC'),
    db.prepare(
      `SELECT p.*, c.name AS category_name,
         (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.id) AS sold_count
       FROM products p
       JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY c.sort_order ASC, p.id ASC`,
    ),
  ]);
  const items = products.results.map((p) => productView(p, role));
  const categories = cats.results.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    count: items.filter((p) => p.categoryId === c.id).length,
  }));
  return json({
    categories,
    products: items,
    viewer: publicUser(ctx.user),
    pricing: {
      role,
      discountPercent: role === 'dealer' ? Math.round(DEALER_DISCOUNT * 100) : 0,
    },
  });
}

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

async function register(ctx) {
  const { env, request, db } = ctx;
  const ip = clientIp(request);
  await enforceRate(db, `register:${ip}`, 20, 10 * 60 * 1000);
  await enforceRate(db, 'register:global', 200, 10 * 60 * 1000);
  const body = await readJson(request, 4096);
  await verifyHuman(ctx, body);

  const username = str(body.username, {
    label: 'ชื่อผู้ใช้',
    min: 3,
    max: 20,
    pattern: /^[a-zA-Z0-9_.]+$/,
  });
  await enforceRate(db, `register:name:${username.toLowerCase()}`, 3, 10 * 60 * 1000);
  const password = str(body.password, { label: 'รหัสผ่าน', min: 6, max: 72 });
  const contact = str(body.contact, { label: 'ช่องทางติดต่อ', max: 60, required: false });
  const email = str(body.email, { label: 'อีเมล', max: 120, required: false });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'รูปแบบอีเมลไม่ถูกต้อง');
  const rawRef = normalizeReferralCode(str(body.ref, { label: 'รหัสเชิญ', max: 16, required: false }));

  const exists = await db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first();
  if (exists) throw new HttpError(409, 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว');

  const referrer = rawRef ? await findReferrerByCode(db, rawRef) : null;
  if (rawRef && !referrer) throw new HttpError(400, 'รหัสเชิญไม่ถูกต้องหรือหมดอายุ');

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const result = await db
    .prepare(
      `INSERT INTO users (username, password_hash, salt, role, balance, display_name, contact, email, referred_by)
       VALUES (?, ?, ?, 'member', 0, ?, ?, ?, ?)`,
    )
    .bind(username, hash, salt, username, contact, email, referrer ? referrer.user_id : null)
    .run();

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(result.meta.last_row_id).first();
  const session = await startSession(ctx, user, isSecureRequest(request));
  await audit(db, user, 'register', `สมัครสมาชิกใหม่ (${username})`);

  // Referral: ให้รางวัลผู้เชิญ (ตรวจฝั่งเซิร์ฟเวอร์ทั้งหมด)
  if (referrer) {
    const reward = await awardSignupReward(db, {
      refereeId: user.id,
      refereeUsername: user.username,
      referrerId: referrer.user_id,
      code: referrer.code,
      ip,
    });
    if (reward) {
      await audit(db, null, 'referral.signup', `#${referrer.user_id} ได้รางวัล ${reward.amount} (${reward.unit}) จาก ${username}`);
    }
    // Fraud: IP เดียวสร้าง referral ผิดปกติ
    const sameIp = await db
      .prepare(
        "SELECT COUNT(*) AS total FROM referral_transactions WHERE ip = ? AND created_at >= datetime('now', '-24 hours')",
      )
      .bind(ip)
      .first();
    if (Number(sameIp?.total || 0) >= 3) {
      await recordFraud(db, {
        userId: user.id,
        type: 'referral_same_ip',
        risk: 'medium',
        description: `มี referral จาก IP ${ip} จำนวน ${sameIp.total} ครั้งใน 24 ชั่วโมง`,
        evidence: { ip, count: sameIp.total, referrer: referrer.user_id },
        ip,
      });
    }
  }

  // Fraud: สมัครถี่ผิดปกติจากระบบทั้งหมด
  const recentSignups = await db
    .prepare("SELECT COUNT(*) AS total FROM users WHERE created_at >= datetime('now', '-10 minutes')")
    .first();
  if (Number(recentSignups?.total || 0) >= 15) {
    await recordFraud(db, {
      userId: user.id,
      type: 'signup_velocity',
      risk: 'medium',
      description: `สมัคร ${recentSignups.total} บัญชีใน 10 นาที`,
      evidence: { count: recentSignups.total, ip },
      ip,
    });
  }

  if (email) {
    await sendEmail(ctx.env, db, {
      userId: user.id,
      to: email,
      event: 'signup',
      vars: { username: user.username },
    });
  }

  return json({ user: publicUser(user), referralApplied: Boolean(referrer) }, 201, { 'set-cookie': session.cookie });
}

async function login(ctx) {
  const { env, request, db } = ctx;
  const ip = clientIp(request);
  await enforceRate(db, `login:${ip}`, 30, 5 * 60 * 1000);
  const body = await readJson(request, 4096);
  const username = str(body.username, { label: 'ชื่อผู้ใช้', min: 1, max: 32 });
  await enforceRate(db, `login:user:${username.toLowerCase()}`, 10, 10 * 60 * 1000);
  await verifyHuman(ctx, body);

  const password = str(body.password, { label: 'รหัสผ่าน', min: 1, max: 100 });
  const user = await db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first();
  const invalid = new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (!user) throw invalid;

  const hash = await hashPassword(password, user.salt);
  if (!safeEqual(hash, user.password_hash)) {
    // Fraud: เข้าสู่ระบบผิดพลาดซ้ำ
    await audit(db, { id: null, username: 'system' }, 'auth.fail', `ล็อกอินผิด: ${username} จาก ${ip}`);
    const fails = await db
      .prepare(
        "SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'auth.fail' AND detail LIKE ? AND created_at >= datetime('now', '-15 minutes')",
      )
      .bind(`%${username}%`)
      .first();
    if (Number(fails?.total || 0) >= 5) {
      await recordFraud(db, {
        userId: user.id,
        type: 'login_failures',
        risk: 'high',
        description: `เข้าสู่ระบบผิดพลาด ${fails.total} ครั้งใน 15 นาที (บัญชี ${username})`,
        evidence: { attempts: fails.total, ip },
        ip,
      });
    }
    throw invalid;
  }
  if (Number(user.restricted) === 1) {
    throw new HttpError(403, `บัญชีนี้ถูกระงับ: ${user.restriction_reason || 'กรุณาติดต่อซัพพอร์ต'}`);
  }

  await db
    .prepare("UPDATE users SET last_login_at = datetime('now'), online_at = datetime('now') WHERE id = ?")
    .bind(user.id)
    .run();
  const session = await startSession(ctx, user, isSecureRequest(request));
  return json({ user: publicUser(user) }, 200, { 'set-cookie': session.cookie });
}

async function logout(ctx) {
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(isSecureRequest(ctx.request)) });
}

async function getMe(ctx) {
  let user = ctx.user;
  if (user) {
    const before = user.role;
    await evaluateReseller(ctx.env.DB, user);
    if (before === 'dealer') user = await ctx.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  }
  let permissions = [];
  if (user && STAFF_SET.has(user.role)) {
    permissions = [...(await permissionsFor(ctx.env.DB, user))];
  }
  return json({
    user: publicUser(user),
    permissions,
    pricing: { role: user ? user.role : 'guest' },
  });
}

/* ------------------------------------------------------------------ */
/* store / orders                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* คูปองส่วนลด — คำนวณและตรวจสอบฝั่งเซิร์ฟเวอร์เท่านั้น                */
/* ------------------------------------------------------------------ */

function normalizeCouponCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function discountFor(coupon, subtotal) {
  const before = money(subtotal);
  const raw = String(coupon.type) === 'fixed'
    ? money(coupon.value)
    : money((before * Number(coupon.value)) / 100);
  // ห้ามส่วนลดเกินราคาสินค้า
  return money(Math.max(0, Math.min(before, raw)));
}

/** คืนข้อมูลคูปองที่ผ่านเงื่อนไขทั้งหมด พร้อมยอดก่อน/หลังหักส่วนลด */
async function validateCoupon(db, codeRaw, product, user, subtotal) {
  const code = normalizeCouponCode(codeRaw);
  if (!code) return null;
  const coupon = await db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').bind(code).first();
  if (!coupon) throw new HttpError(404, 'ไม่พบคูปองโค้ดนี้');
  if (Number(coupon.active) !== 1) throw new HttpError(400, 'คูปองนี้ถูกปิดใช้งานแล้ว');

  const nowMs = Date.now();
  const startsAt = coupon.starts_at ? Date.parse(coupon.starts_at) : NaN;
  const expiresAt = coupon.expires_at ? Date.parse(coupon.expires_at) : NaN;
  if (!Number.isNaN(startsAt) && startsAt > nowMs) throw new HttpError(400, 'คูปองนี้ยังไม่เริ่มใช้งาน');
  if (!Number.isNaN(expiresAt) && expiresAt < nowMs) throw new HttpError(400, 'คูปองนี้หมดอายุแล้ว');

  if (Number(coupon.max_uses) > 0 && Number(coupon.used_count) >= Number(coupon.max_uses)) {
    throw new HttpError(400, 'คูปองนี้ถูกใช้ครบจำนวนแล้ว');
  }
  if (coupon.product_id && Number(coupon.product_id) !== Number(product.id)) {
    throw new HttpError(400, 'คูปองนี้ใช้ได้เฉพาะสินค้าที่กำหนดเท่านั้น');
  }
  if (coupon.category_id && Number(coupon.category_id) !== Number(product.category_id)) {
    throw new HttpError(400, 'คูปองนี้ใช้ได้เฉพาะหมวดหมู่ที่กำหนดเท่านั้น');
  }
  if (Number(coupon.per_user_limit) > 0) {
    const used = await db
      .prepare('SELECT COUNT(*) AS total FROM coupon_usages WHERE coupon_id = ? AND user_id = ?')
      .bind(coupon.id, user.id)
      .first();
    if (Number(used?.total || 0) >= Number(coupon.per_user_limit)) {
      throw new HttpError(400, 'คุณใช้คูปองนี้ครบจำนวนสิทธิ์แล้ว');
    }
  }

  const before = money(subtotal);
  const minSpend = money(coupon.min_spend);
  if (before < minSpend) {
    throw new HttpError(400, `คูปองนี้ใช้ได้เมื่อซื้อขั้นต่ำ ฿${minSpend.toLocaleString('th-TH')}`);
  }

  const discount = discountFor(coupon, before);
  return {
    coupon,
    code: coupon.code,
    subtotal: before,
    discount,
    total: money(before - discount),
  };
}

/** คืนสิทธิ์คูปองเมื่อรายการซื้อไม่สำเร็จ (เช่น ยอดเงินไม่พอ หรือบันทึกออเดอร์พลาด) */
async function releaseCouponUse(db, couponId) {
  await db
    .prepare('UPDATE coupons SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END WHERE id = ?')
    .bind(couponId)
    .run();
}

async function releaseStock(db, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  await db
    .prepare(`UPDATE stock_items SET status = 'available', sold_at = NULL, order_id = NULL WHERE id IN (${placeholders}) AND status = 'sold'`)
    .bind(...ids)
    .run();
}

/**
 * ซื้อสินค้า: ตัดเครดิต + ส่งคีย์จากสต็อกอัตโนมัติทันที
 * ลำดับ: จองคีย์ → หักเงิน → บันทึกออเดอร์ → ผูกคีย์กับออเดอร์ (ผิดพลาดที่ขั้นไหนคืนคีย์ให้)
 */
async function purchaseKeys(db, env, user, productId, quantity, clientToken = '', couponCode = '') {
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first();
  if (!product || Number(product.active) !== 1) throw new HttpError(404, 'ไม่พบสินค้านี้');

  const freshUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  if (Number(freshUser.restricted) === 1) {
    throw new HttpError(403, `บัญชีนี้ถูกระงับการทำธุรกรรม: ${freshUser.restriction_reason || 'กรุณาติดต่อซัพพอร์ต'}`);
  }
  const unitPrice = priceFor(product, freshUser.role);
  const subtotal = money(unitPrice * quantity);
  let total = subtotal;
  let couponApplied = null;
  if (couponCode) {
    couponApplied = await validateCoupon(db, couponCode, product, freshUser, subtotal);
    total = couponApplied.total;
    // จองสิทธิ์คูปองแบบมีเงื่อนไข → กันการใช้เกินจำนวนครั้งแม้มีคนกดพร้อมกัน
    const reserved = await db
      .prepare(
        'UPDATE coupons SET used_count = used_count + 1 WHERE id = ? AND (max_uses = 0 OR used_count < max_uses)',
      )
      .bind(couponApplied.coupon.id)
      .run();
    if (Number(reserved.meta.changes) !== 1) throw new HttpError(409, 'คูปองนี้ถูกใช้ครบจำนวนแล้ว');
  }
  if (money(freshUser.balance) < total) {
    if (couponApplied) await releaseCouponUse(db, couponApplied.coupon.id);
    throw new HttpError(400, `ยอดเงินไม่เพียงพอ ต้องใช้ ฿${total.toLocaleString('th-TH')} กรุณาเติมเงินก่อน`);
  }

  // ห้ามส่งคีย์ตัวอย่าง DEMO- ให้ลูกค้าเด็ดขาด (กรองทั้งสถานะและคำนำหน้า)
  const available = await db
    .prepare(
      `SELECT id, code FROM stock_items
       WHERE product_id = ? AND status = 'available' AND code NOT LIKE 'DEMO-%'
       ORDER BY id ASC LIMIT ?`,
    )
    .bind(productId, quantity)
    .all();
  const picked = available.results;
  if (picked.length < quantity) {
    if (couponApplied) await releaseCouponUse(db, couponApplied.coupon.id);
    const demo = await db
      .prepare("SELECT COUNT(*) AS total FROM stock_items WHERE product_id = ? AND code LIKE 'DEMO-%' AND status <> 'sold'")
      .bind(productId)
      .first();
    const hint =
      Number(demo?.total || 0) > 0
        ? ' — สินค้านี้ยังไม่มีคีย์จริง (คีย์ตัวอย่าง DEMO ใช้ขายไม่ได้) กรุณาแจ้งแอดมินใส่คีย์จริงก่อน'
        : '';
    throw new HttpError(400, `คีย์จริงคงเหลือไม่พอ (เหลือ ${picked.length} ชิ้น)${hint} กรุณาเลือกจำนวนน้อยลง`);
  }

  const ids = picked.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const claimed = await db
    .prepare(
      `UPDATE stock_items SET status = 'sold', sold_at = datetime('now')
       WHERE id IN (${placeholders}) AND status = 'available'`,
    )
    .bind(...ids)
    .run();
  if (Number(claimed.meta.changes) !== quantity) {
    await releaseStock(db, ids);
    if (couponApplied) await releaseCouponUse(db, couponApplied.coupon.id);
    throw new HttpError(409, 'มีผู้ซื้อรายอื่นแย่งคีย์ไปแล้ว กรุณาลองใหม่อีกครั้ง');
  }

  const balanceUpdate = await db
    .prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
    .bind(total, user.id, total)
    .run();
  if (Number(balanceUpdate.meta.changes) !== 1) {
    await releaseStock(db, ids);
    if (couponApplied) await releaseCouponUse(db, couponApplied.coupon.id);
    throw new HttpError(400, 'ยอดเงินไม่เพียงพอ กรุณาเติมเงินก่อน');
  }

  let orderId;
  try {
    const order = await db
      .prepare(
        `INSERT INTO orders (user_id, product_id, product_name, quantity, unit_price, total, status, client_token, coupon_code, discount)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
      )
      .bind(
        user.id,
        productId,
        product.name,
        quantity,
        unitPrice,
        total,
        clientToken,
        couponApplied ? couponApplied.code : '',
        couponApplied ? couponApplied.discount : 0,
      )
      .run();
    orderId = order.meta.last_row_id;
  } catch (error) {
    await releaseStock(db, ids);
    await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(total, user.id).run();
    if (couponApplied) await releaseCouponUse(db, couponApplied.coupon.id);
    throw error;
  }

  await db.batch([
    ...picked.map((row) =>
      db
        .prepare('INSERT INTO order_items (order_id, product_id, code) VALUES (?, ?, ?)')
        .bind(orderId, productId, row.code),
    ),
    db.prepare(`UPDATE stock_items SET order_id = ? WHERE id IN (${placeholders})`).bind(orderId, ...ids),
    ...(couponApplied
      ? [
          db
            .prepare(
              `INSERT INTO coupon_usages (coupon_id, user_id, order_id, code, discount, subtotal, total)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              couponApplied.coupon.id,
              user.id,
              orderId,
              couponApplied.code,
              couponApplied.discount,
              subtotal,
              total,
            ),
        ]
      : []),
  ]);
  await syncStock(db, productId);

  // Wallet Ledger — บันทึกการหักเครดิต (idempotency กันบันทึกซ้ำเมื่อ retry)
  try {
    const bal = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(user.id).first();
    const current = fromSatang(toSatang(bal?.balance || 0));
    await db
      .prepare(
        `INSERT INTO wallet_transactions
           (user_id, kind, amount, balance_before, balance_after, ref_type, ref_id, note, idempotency_key)
         VALUES (?, 'purchase', ?, ?, ?, 'order', ?, ?, ?)`,
      )
      .bind(
        user.id,
        -total,
        fromSatang(toSatang(current) + toSatang(total)),
        current,
        orderId,
        `ซื้อ ${product.name} × ${quantity}`,
        `order:${orderId}`,
      )
      .run();
  } catch {
    /* การบันทึก ledger ซ้ำต้องไม่ทำให้คำสั่งซื้อล้มเหลว */
  }

  // Order Tracking — บันทึกประวัติทุกขั้น (ใช้เวลาจริง ณ ตอนเกิดเหตุ)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await db.batch([
    db
      .prepare("INSERT INTO order_status_history (order_id, status, note, actor_name, created_at) VALUES (?, 'created', ?, 'system', ?)")
      .bind(orderId, 'สร้างคำสั่งซื้อโดยสมาชิก', now),
    db
      .prepare("INSERT INTO order_status_history (order_id, status, note, actor_name, created_at) VALUES (?, 'paid', ?, 'system', ?)")
      .bind(orderId, `หักเครดิตกระเป๋า ฿${total}`, now),
    db
      .prepare("INSERT INTO order_status_history (order_id, status, note, actor_name, created_at) VALUES (?, 'processing', ?, 'system', ?)")
      .bind(orderId, 'จองคีย์จากคลังสำเร็จ', now),
    db
      .prepare("INSERT INTO order_status_history (order_id, status, note, actor_name, created_at) VALUES (?, 'key_assigned', ?, 'system', ?)")
      .bind(orderId, `มอบคีย์ ${picked.length} รายการ`, now),
    db
      .prepare("INSERT INTO order_status_history (order_id, status, note, actor_name, created_at) VALUES (?, 'delivered', ?, 'system', ?)")
      .bind(orderId, 'ส่งมอบคีย์ให้สมาชิกแล้ว', now),
  ]);

  if (freshUser.email && emailConfig(env).configured) {
    const codes = picked.map((row) => row.code).join('\n');
    await sendEmail(env, db, {
      userId: user.id,
      to: freshUser.email,
      event: 'order_paid',
      vars: { orderId, total, product: product.name },
    });
    await sendEmail(env, db, {
      userId: user.id,
      to: freshUser.email,
      event: 'key_delivered',
      vars: { orderId, codes },
    });
  }

  // Referral: รางวัลเพื่อนซื้อครั้งแรก (ให้ครั้งเดียวต่อผู้ถูกเชิญ)
  await awardFirstPurchaseReward(db, {
    buyerId: user.id,
    buyerUsername: freshUser.username,
    orderId,
    ip: '',
  });

  const updated = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(user.id).first();
  return {
    order: {
      id: orderId,
      productId,
      productName: product.name,
      quantity,
      unitPrice,
      total,
      subtotal,
      discount: couponApplied ? couponApplied.discount : 0,
      couponCode: couponApplied ? couponApplied.code : '',
      codes: picked.map((row) => row.code),
      delivered: true,
      createdAt: new Date().toISOString(),
    },
    balance: money(updated.balance),
    message: couponApplied
      ? `ซื้อสำเร็จ ลด ${money(couponApplied.discount)} ด้วยคูปอง ${couponApplied.code} — ส่งคีย์อัตโนมัติแล้ว ${quantity} รายการ`
      : `ซื้อสำเร็จ ส่งคีย์อัตโนมัติแล้ว ${quantity} รายการ`,
  };
}

async function createOrder(ctx) {
  const { db, request } = ctx;
  const user = requireUser(ctx);
  await enforceRate(db, `order:${user.id}`, 20, 60 * 1000);
  await enforceRate(db, `order:ip:${ctx.ip}`, 60, 60 * 1000);
  const body = await readJson(request, 2048);
  const productId = num(body.productId, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
  const quantity = num(body.quantity ?? 1, { label: 'จำนวน', min: 1, max: 10, integer: true });
  // กันการกดซื้อซ้ำ: เบราว์เซอร์ส่ง token ประจำการกดหนึ่งครั้ง ระบบปฏิเสธ token ที่ถูกใช้แล้ว
  const clientToken = str(body.clientToken, { label: 'รหัสคำขอ', max: 64, required: false });
  const couponCode = normalizeCouponCode(str(body.couponCode, { label: 'โค้ดคูปอง', max: 32, required: false }));
  if (clientToken) {
    const used = await db
      .prepare('SELECT id FROM orders WHERE user_id = ? AND client_token = ? LIMIT 1')
      .bind(user.id, clientToken)
      .first();
    if (used) throw new HttpError(409, 'คำสั่งซื้อนี้ถูกบันทึกไปแล้ว กรุณาตรวจสอบประวัติการซื้อ');
  }
  // Fraud: ซื้อถี่ผิดปกติ (เช่น สคริปต์กดซื้อรัว)
  const recent = await db
    .prepare("SELECT COUNT(*) AS total FROM orders WHERE user_id = ? AND created_at >= datetime('now', '-2 minutes')")
    .bind(user.id)
    .first();
  if (Number(recent?.total || 0) >= 5) {
    await recordFraud(db, {
      userId: user.id,
      type: 'rapid_purchase',
      risk: 'medium',
      description: `ซื้อ ${recent.total} ออเดอร์ใน 2 นาที`,
      evidence: { orders: recent.total, productId },
      ip: ctx.ip,
    });
  }
  const result = await purchaseKeys(db, ctx.env, user, productId, quantity, clientToken, couponCode);
  return json({ ok: true, ...result }, 201);
}

/** ตรวจคูปองก่อนกดซื้อ — ผลลัพธ์ใช้แสดงส่วนลดเท่านั้น ระบบคิดเงินจริงตอนยืนยันคำสั่งซื้ออีกครั้ง */
async function quoteCoupon(ctx) {
  const { db, request } = ctx;
  const user = requireUser(ctx);
  await enforceRate(db, `coupon:${user.id}`, 30, 60 * 1000);
  const body = await readJson(request, 1024);
  const code = str(body.code, { label: 'โค้ดคูปอง', min: 1, max: 32 });
  const productId = num(body.productId, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
  const quantity = num(body.quantity ?? 1, { label: 'จำนวน', min: 1, max: 10, integer: true });
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first();
  if (!product || Number(product.active) !== 1) throw new HttpError(404, 'ไม่พบสินค้านี้');
  const subtotal = money(priceFor(product, user.role) * quantity);
  const quote = await validateCoupon(db, code, product, user, subtotal);
  return json({
    ok: true,
    coupon: {
      code: quote.code,
      type: quote.coupon.type,
      value: money(quote.coupon.value),
      label:
        String(quote.coupon.type) === 'fixed'
          ? `ลด ${money(quote.coupon.value)} บาท`
          : `ลด ${money(quote.coupon.value)}%`,
    },
    subtotal: quote.subtotal,
    discount: quote.discount,
    total: quote.total,
    message: `ใช้คูปอง ${quote.code} สำเร็จ ลด ${money(quote.discount)}`,
  });
}

/* ---------- สถานะเรียลไทม์ (ใช้ร่วมกับตัวดึงข้อมูลฝั่งเบราว์เซอร์) ---------- */

async function liveState(ctx) {
  const db = ctx.env.DB;
  const user = ctx.user;
  const statements = [
    db.prepare('SELECT id, price, stock FROM products WHERE active = 1 ORDER BY id ASC'),
    db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM orders'),
    db.prepare(
      "SELECT COALESCE(MAX(id), 0) AS id, COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending FROM topups",
    ),
  ];
  if (user) {
    statements.push(db.prepare('SELECT balance FROM users WHERE id = ?').bind(user.id));
    statements.push(
      db.prepare('SELECT COALESCE(MAX(id), 0) AS id, COUNT(*) AS total FROM orders WHERE user_id = ?').bind(user.id),
    );
    statements.push(
      db
        .prepare("SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending FROM topups WHERE user_id = ?")
        .bind(user.id),
    );
    statements.push(
      db.prepare('SELECT id, status, amount, net FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(user.id),
    );
  }

  const rows = await db.batch(statements);
  const products = rows[0].results;
  const maxOrder = Number(rows[1].results[0]?.id || 0);
  const maxTopup = Number(rows[2].results[0]?.id || 0);
  const pendingTopups = Number(rows[2].results[0]?.pending || 0);

  const me = user
    ? {
        balance: money(rows[3].results[0]?.balance || 0),
        lastOrderId: Number(rows[4].results[0]?.id || 0),
        orderCount: Number(rows[4].results[0]?.total || 0),
        pendingTopups: Number(rows[5].results[0]?.pending || 0),
        lastTopup: rows[6]?.results?.[0]
          ? {
              id: Number(rows[6].results[0].id),
              status: rows[6].results[0].status,
              amount: money(rows[6].results[0].amount),
              net: money(rows[6].results[0].net),
            }
          : null,
      }
    : null;

  const staff =
    user && roleRank(user.role) <= STAFF_RANK
      ? { lastOrderId: maxOrder, lastTopupId: maxTopup, pendingTopups }
      : null;

  const stockRev = products.map((p) => `${p.id}:${p.stock}:${money(p.price)}`).join('|');
  return json({
    at: Date.now(),
    rev: `${maxOrder}-${maxTopup}-${pendingTopups}-${stockRev}`,
    products: products.map((p) => ({ id: p.id, stock: Number(p.stock), price: money(p.price) })),
    me,
    staff,
  });
}

async function listMyOrders(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  const rows = await db
    .prepare(
      `SELECT id, product_name, quantity, unit_price, total, status, created_at
       FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
    )
    .bind(user.id)
    .all();
  const orders = rows.results;
  const codesByOrder = new Map();
  if (orders.length) {
    const ids = orders.map((o) => o.id);
    const placeholders = ids.map(() => '?').join(',');
    const codeRows = await db
      .prepare(`SELECT order_id, code FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`)
      .bind(...ids)
      .all();
    for (const row of codeRows.results) {
      if (!codesByOrder.has(row.order_id)) codesByOrder.set(row.order_id, []);
      codesByOrder.get(row.order_id).push(row.code);
    }
  }
  return json({
    orders: orders.map((o) => ({
      id: o.id,
      productName: o.product_name,
      quantity: o.quantity,
      unitPrice: money(o.unit_price),
      total: money(o.total),
      status: o.status,
      codes: codesByOrder.get(o.id) || [],
      createdAt: o.created_at,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* top-ups                                                             */
/* ------------------------------------------------------------------ */

/** มุมมองคำขอเติมเงินที่ส่งให้สมาชิก (ไม่เปิดเผยข้อมูลผู้ตรวจภายใน) */
function topupView(row) {
  if (!row) return null;
  return {
    id: row.id,
    method: row.method,
    status: row.status,
    amount: money(row.amount),
    fee: money(row.fee),
    net: money(row.net),
    declaredAmount: money(row.declared_amount || row.amount),
    reference: row.reference,
    note: row.review_note || row.note || '',
    verification: row.verification_source || 'none',
    voucherCode: row.voucher_code || '',
    auto: row.status === 'approved' && !row.reviewed_by && row.method === 'envelope',
    balanceAfter: row.balance_after ? money(row.balance_after) : null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
  };
}

/** ดึงรหัสซอง (voucher) จากลิงก์ซองทรู เพื่อกันการแจ้งซองเดิมซ้ำ */
function envelopeVoucherCode(reference) {
  const raw = String(reference || '').trim();
  // รับเฉพาะลิงก์ซองของ TrueMoney เท่านั้น
  if (!/^https?:\/\/([a-z0-9-]+\.)*truemoney\.com\//i.test(raw)) return '';
  const match = raw.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  return match ? match[1] : '';
}

/** ข้อความตอบกลับจากทรูมันนี่ → ข้อความที่ผู้ใช้เห็น */
const TM_FAIL_MESSAGES = {
  VOUCHER_NOT_FOUND: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  VOUCHER_OUT_OF_STOCK: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  VOUCHER_ALREADY_USED: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  INTERNAL_ERROR: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  BAD_PARAM: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  TARGET_USER_REDEEMED: 'ซองนี้ถูกรับเงินไปแล้ว ไม่สามารถรับซ้ำได้',
  VOUCHER_EXPIRED: 'ซองนี้หมดอายุแล้ว (เกิน 72 ชั่วโมง) กรุณาสร้างซองใหม่',
  CANNOT_GET_OWN_VOUCHER: 'รับซองที่ตัวเองสร้างไม่ได้ กรุณาใช้ซองที่ลูกค้าส่งมาให้ร้าน',
  TARGET_USER_NOT_FOUND: `เบอร์รับเงิน ${TICKET_PHONE} ยังไม่ผูกพร้อมเพย์/วอลเล็ต กรุณาแจ้งแอดมิน`,
};

// รหัสที่สรุปได้ชัดเจนว่าซองใช้ไม่ได้ (รหัสอื่น = ยังตรวจไม่ได้ ต้องรอแอดมิน)
const TM_DEFINITIVE_CODES = new Set([
  'VOUCHER_NOT_FOUND',
  'VOUCHER_ALREADY_USED',
  'VOUCHER_EXPIRED',
  'VOUCHER_OUT_OF_STOCK',
  'TARGET_USER_REDEEMED',
]);

/** ส่งซองผ่าน relay ของร้าน (tools/truemoney-relay.mjs) — คืน null เมื่อ relay ใช้งานไม่ได้ */
async function redeemViaRelay(env, relayUrl, voucher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(relayUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(env.TRUEMONEY_RELAY_TOKEN ? { Authorization: `Bearer ${env.TRUEMONEY_RELAY_TOKEN}` } : {}),
      },
      body: JSON.stringify({ voucher, mobile: TICKET_PHONE }),
    });
    const payload = await response.json().catch(() => null);
    if (!payload) return null;
    if (payload.ok && Number(payload.amount) > 0) {
      return {
        ok: true,
        amount: money(payload.amount),
        sender: String(payload.sender || '').slice(0, 80),
        message: String(payload.message || 'Voucher redeemed successfully!').slice(0, 160),
      };
    }
    if (payload.ok === false && payload.unreachable) return null;
    const code = String(payload.code || 'RELAY_REJECT');
    return {
      ok: false,
      unreachable: !TM_DEFINITIVE_CODES.has(code),
      code,
      message: TM_FAIL_MESSAGES[code] || String(payload.message || 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว').slice(0, 160),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ส่งลิงก์ซอง + เบอร์รับเงินของร้านไปรับเงินจากทรูมันนี่ แล้วคืนยอดที่ได้รับจริง
 * ใช้ endpoint เดียวกับหน้า gift.truemoney.com (ไม่เป็นทางการ) — ซองใช้ได้ครั้งเดียว
 */
async function redeemTrueMoneyEnvelope(env, voucher) {
  // ที่อยู่ Worker บน Cloudflare ถูก WAF ของทรูมันนี่บล็อก (HTTP 403)
  // ถ้าตั้ง TRUEMONEY_RELAY_URL ไว้ (เครื่อง/VPS ของร้านที่ทรูมันนี่ไม่บล็อก) จะใช้ทางนั้น
  const relayUrl = env.TRUEMONEY_RELAY_URL || '';
  if (relayUrl) {
    const relayed = await redeemViaRelay(env, relayUrl, voucher);
    if (relayed) return relayed;
  }
  // ค่าเริ่มต้นคือ "Not Configured": ไม่มีช่องทางตรวจสอบที่ได้รับอนุญาต → ให้แอดมินตรวจเอง
  // (การยิงตรงไปยัง gift.truemoney.com ไม่ใช่ช่องทางที่ได้รับอนุญาต และถูก WAF บล็อกอยู่แล้ว)
  // เปิดใช้การยิงตรงได้เฉพาะเมื่อร้านตั้ง TRUEMONEY_DIRECT=1 อย่างชัดเจน
  if (env.TRUEMONEY_DIRECT !== '1') {
    return {
      ok: false,
      unreachable: true,
      message: 'ยังไม่ได้ตั้งค่าช่องทางตรวจสอบซอง (TRUEMONEY_RELAY_URL) — รอแอดมินตรวจสอบด้วยตนเอง',
    };
  }
  const url = `https://gift.truemoney.com/campaign/vouchers/${encodeURIComponent(voucher)}/redeem`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response = null;
  let text = '';
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
        Origin: 'https://gift.truemoney.com',
        Referer: `https://gift.truemoney.com/campaign/?v=${encodeURIComponent(voucher)}`,
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      },
      body: JSON.stringify({ mobile: TICKET_PHONE, voucher_hash: voucher }),
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      unreachable: true,
      message: 'เชื่อมต่อทรูมันนี่ไม่ได้ในขณะนี้',
    };
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!payload || !payload.status) {
    console.warn('TM_REDEEM_NO_JSON', response.status, text.slice(0, 120).replace(/\s+/g, ' '));
    return {
      ok: false,
      unreachable: response.status === 403 || response.status === 429 || response.status >= 500,
      message: `ทรูมันนี่ตอบกลับผิดรูปแบบ (HTTP ${response.status})`,
    };
  }

  const code = String(payload.status.code || '');
  if (code !== 'SUCCESS') console.warn('TM_REDEEM_FAIL', response.status, code);
  if (code !== 'SUCCESS') {
    // เฉพาะรหัสที่สรุปได้ชัดเจนว่า "ใช้ไม่ได้" จึงปฏิเสธทันที รหัสอื่นถือว่ายังตรวจไม่ได้ → รอแอดมิน
    return {
      ok: false,
      unreachable: !TM_DEFINITIVE_CODES.has(code),
      code,
      message: TM_FAIL_MESSAGES[code] || payload.status.message || 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
    };
  }

  const voucherData = payload.data?.voucher || {};
  const rawAmount =
    payload.data?.my_ticket?.amount_baht || voucherData.redeemed_amount_baht || voucherData.amount_baht || '0';
  const received = money(Number(String(rawAmount).replace(/,/g, '')) || 0);
  if (!(received > 0)) {
    return {
      ok: false,
      unreachable: true,
      message: 'ทรูมันนี่รับเงินแล้วแต่ไม่มียอดส่งกลับมา',
    };
  }
  return {
    ok: true,
    amount: received,
    sender: payload.data?.owner_profile?.full_name || '',
    message: payload.status.message || 'Voucher redeemed successfully!',
  };
}

async function createTopup(ctx) {
  const { db, request } = ctx;
  const user = requireUser(ctx);
  if (Number(user.restricted) === 1) {
    throw new HttpError(403, `บัญชีนี้ถูกระงับการทำธุรกรรม: ${user.restriction_reason || 'กรุณาติดต่อซัพพอร์ต'}`);
  }
  await enforceRate(db, `topup:${user.id}`, 6, 10 * 60 * 1000);
  const body = await readJson(request, 3072);
  const method = str(body.method, { label: 'ช่องทางเติมเงิน', min: 3, max: 12 });
  if (method !== 'envelope' && method !== 'bank') throw new HttpError(400, 'ช่องทางเติมเงินไม่ถูกต้อง');
  const amount = money(num(body.amount, { label: 'จำนวนเงิน', min: 20, max: 10000 }));
  const reference = str(body.reference, { label: 'ลิงก์ซอง/เลขอ้างอิง', min: 6, max: 300 });
  const note = str(body.note, { label: 'หมายเหตุ', max: 200, required: false });
  if (method === 'envelope' && !/^https?:\/\//i.test(reference)) {
    throw new HttpError(400, 'กรุณาวางลิงก์ซองทรู (เริ่มต้นด้วย https://)');
  }

  const clientToken = str(body.clientToken, { label: 'รหัสคำขอ', max: 64, required: false });
  if (method === 'envelope' && clientToken) {
    const existing = await db
      .prepare('SELECT * FROM topups WHERE user_id = ? AND idempotency_key = ? LIMIT 1')
      .bind(user.id, clientToken)
      .first();
    if (existing) {
      return json({
        ok: true,
        auto: existing.status === 'approved',
        pending: ['pending', 'verifying'].includes(existing.status),
        topup: topupView(existing),
        message: 'คำขอนี้ถูกบันทึกไว้แล้ว ระบบไม่เพิ่มเครดิตซ้ำ',
      });
    }
  }

  // ---------- TrueMoney Gift Envelope ----------
  if (method === 'envelope') {
    const voucher = envelopeVoucherCode(reference);
    if (!voucher) throw new HttpError(400, 'ลิงก์ซองไม่ถูกต้อง กรุณาคัดลอกจากซองทรูอีกครั้ง');
    const normalized = `https://gift.truemoney.com/campaign/?v=${voucher}`;

    // 1) ซองเดิมที่ยังอยู่ในระบบ (รอตรวจ/อนุมัติ/ซ้ำ) → ปฏิเสธทันที
    const used = await db
      .prepare(
        `SELECT id, user_id, status FROM topups
         WHERE method = 'envelope'
           AND status IN ('pending', 'verifying', 'approved', 'duplicate')
           AND (voucher_code = ? OR voucher_code = '' AND (reference = ? OR reference = ? OR reference LIKE ?))
         LIMIT 1`,
      )
      .bind(voucher, reference, normalized, `%v=${voucher}%`)
      .first();
    if (used) {
      const duplicate = await db
        .prepare(
          `INSERT INTO topups (user_id, method, amount, fee, net, reference, note, status, voucher_code,
             verification_source, declared_amount, review_note)
           VALUES (?, 'envelope', 0, 0, 0, ?, ?, 'duplicate', ?, 'none', ?, ?)`,
        )
        .bind(
          user.id,
          reference,
          note,
          voucher,
          amount,
          `ซองนี้ถูกใช้ในระบบแล้ว (รายการ #${used.id}, สถานะ ${used.status})`,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO topup_verifications (topup_id, actor_name, action, amount, evidence, note)
           VALUES (?, 'system', 'duplicate_blocked', 0, ?, ?)`,
        )
        .bind(
          duplicate.meta.last_row_id,
          `ตรวจพบ voucher ${voucher} ซ้ำกับรายการ #${used.id}`,
          'ปฏิเสธอัตโนมัติ — ซองเดียวเพิ่มเครดิตได้ครั้งเดียว',
        )
        .run();
      return json(
        {
          ok: false,
          error:
            used.user_id === user.id
              ? 'คุณแจ้งซองนี้ไปแล้ว — ระบบกำลังตรวจสอบยอด ไม่ต้องแจ้งซ้ำ'
              : 'ซองนี้ถูกใช้ในระบบแล้ว ไม่สามารถใช้ซ้ำได้',
          status: 'duplicate',
          topup: { id: duplicate.meta.last_row_id, status: 'duplicate', method, amount: 0, fee: 0, net: 0 },
        },
        409,
      );
    }

    const balanceRow = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(user.id).first();
    const declared = splitFee(amount, FEE_PERCENT);

    // 2) บันทึกคำขอก่อน (สถานะ verifying) เพื่อให้มี Audit Trail เสมอ
    const created = await db
      .prepare(
        `INSERT INTO topups (user_id, method, amount, fee, net, reference, note, status, voucher_code,
           verification_source, idempotency_key, declared_amount, balance_before)
         VALUES (?, 'envelope', ?, ?, ?, ?, ?, 'verifying', ?, 'none', ?, ?, ?)`,
      )
      .bind(
        user.id,
        declared.amount,
        declared.fee,
        declared.net,
        reference,
        note,
        voucher,
        clientToken,
        declared.amount,
        fromSatang(toSatang(balanceRow?.balance || 0)),
      )
      .run();
    const topupId = created.meta.last_row_id;

    // 3) ตรวจสอบกับทรูมันนี่ (ผ่าน relay ที่ร้านตั้งไว้ หรือยิงตรง)
    const redeemed = await redeemTrueMoneyEnvelope(ctx.env, voucher);
    const relayConfigured = Boolean(ctx.env.TRUEMONEY_RELAY_URL);

    if (redeemed.ok) {
      // ยอดจริงจากซองเท่านั้นที่นำมาคิดเครดิต
      const split = splitFee(redeemed.amount, FEE_PERCENT);
      if (!(split.amountSatang > 0)) {
        await db
          .prepare("UPDATE topups SET status = 'pending', review_note = ? WHERE id = ?")
          .bind('ทรูมันนี่ตอบกลับโดยไม่มียอดเงิน — รอแอดมินตรวจ', topupId)
          .run();
        return json({ ok: true, auto: false, pending: true, topup: { id: topupId, status: 'pending' }, message: 'ไม่สามารถยืนยันยอดจากซองได้ ส่งให้แอดมินตรวจสอบแล้ว' }, 201);
      }

      // ซองเดียวเพิ่มเครดิตได้ครั้งเดียว (UNIQUE ที่ฐานข้อมูล)
      try {
        await db
          .prepare(
            `INSERT INTO gift_envelope_transactions (topup_id, voucher_code, phone, amount, status, source, raw_response)
             VALUES (?, ?, ?, ?, 'approved', ?, ?)`,
          )
          .bind(
            topupId,
            voucher,
            TICKET_PHONE,
            split.amount,
            relayConfigured ? 'relay' : 'api',
            JSON.stringify({ sender: redeemed.sender || '', message: redeemed.message || '' }).slice(0, 900),
          )
          .run();
      } catch {
        await db
          .prepare("UPDATE topups SET status = 'duplicate', review_note = ? WHERE id = ?")
          .bind('ซองนี้เคยถูกเพิ่มเครดิตไปแล้ว (ฐานข้อมูลปฏิเสธรายการซ้ำ)', topupId)
          .run();
        return json(
          { ok: false, error: 'ซองนี้ถูกใช้ในระบบแล้ว ไม่สามารถใช้ซ้ำได้', status: 'duplicate', topup: { id: topupId, status: 'duplicate' } },
          409,
        );
      }

      const credit = await creditWallet(db, {
        userId: user.id,
        amountSatang: split.netSatang,
        kind: 'topup',
        refType: 'topup',
        refId: topupId,
        note: `เติมเงินซองทรู ฿${split.amount.toFixed(2)} (ค่าธรรมเนียม ${FEE_PERCENT}%)`,
        idempotencyKey: `topup:${topupId}`,
      });

      await db
        .prepare(
          `UPDATE topups SET amount = ?, fee = ?, net = ?, status = 'approved', verification_source = ?,
             balance_after = ?, reviewed_at = datetime('now'), review_note = ?
           WHERE id = ? AND status IN ('pending', 'verifying')`,
        )
        .bind(
          split.amount,
          split.fee,
          split.net,
          relayConfigured ? 'relay' : 'api',
          credit.after,
          `ยืนยันยอดจริงจากทรูมันนี่ ฿${split.amount.toFixed(2)}${redeemed.sender ? ` · ผู้ส่ง ${redeemed.sender}` : ''}`,
          topupId,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO topup_verifications (topup_id, actor_name, action, amount, evidence, note)
           VALUES (?, 'system', 'auto_verified', ?, ?, ?)`,
        )
        .bind(
          topupId,
          split.amount,
          `source=${relayConfigured ? 'relay' : 'api'} voucher=${voucher}`,
          `เครดิตเข้า ฿${split.net.toFixed(2)} (ค่าธรรมเนียม ฿${split.fee.toFixed(2)})`,
        )
        .run();

      await recordFraud(db, {
        userId: user.id,
        type: 'wallet_mismatch',
        risk: 'low',
        description: `ยอดแจ้ง ฿${declared.amount.toFixed(2)} ≠ ยอดจริงในซอง ฿${split.amount.toFixed(2)} — ใช้ยอดจริง`,
        evidence: { topupId, declared: declared.amount, actual: split.amount },
        ip: ctx.ip,
      }).catch(() => null);

      return json(
        {
          ok: true,
          auto: true,
          pending: false,
          status: 'approved',
          topup: {
            id: topupId,
            method,
            status: 'approved',
            amount: split.amount,
            fee: split.fee,
            net: split.net,
            declaredAmount: declared.amount,
            verification: relayConfigured ? 'relay' : 'api',
          },
          envelope: { amount: split.amount, fee: split.fee, net: split.net, feePercent: FEE_PERCENT },
          balance: money(credit.after),
          message: `รับเงินสำเร็จ ฿${split.amount.toFixed(2)} — ค่าธรรมเนียม ${FEE_PERCENT}% (฿${split.fee.toFixed(2)}) เข้าเครดิต ฿${split.net.toFixed(2)}`,
          notice:
            declared.amount !== split.amount
              ? `ยอดในซองจริง ฿${split.amount.toFixed(2)} ระบบใช้ยอดจริงจากทรูมันนี่ ไม่ใช้ยอดที่แจ้ง`
              : '',
        },
        201,
      );
    }

    // 4) ตรวจแล้วไม่ผ่าน (ลิงก์ผิด/ใช้แล้ว/หมดอายุ) → บันทึกสถานะตามจริง ไม่เพิ่มเครดิต
    if (!redeemed.unreachable) {
      const status = redeemed.code === 'VOUCHER_EXPIRED' ? 'expired' : 'rejected';
      await db
        .prepare("UPDATE topups SET status = ?, verification_source = 'api', review_note = ? WHERE id = ?")
        .bind(status, redeemed.message, topupId)
        .run();
      await db
        .prepare(
          `INSERT INTO topup_verifications (topup_id, actor_name, action, amount, evidence, note)
           VALUES (?, 'system', 'auto_verify_failed', 0, ?, ?)`,
        )
        .bind(topupId, `code=${redeemed.code || 'UNKNOWN'} voucher=${voucher}`, redeemed.message)
        .run();
      return json(
        {
          ok: false,
          error: redeemed.message,
          status,
          topup: { id: topupId, status, method, amount: 0, fee: 0, net: 0, note: redeemed.message },
        },
        400,
      );
    }

    // 5) ติดต่อทรูมันนี่ไม่ได้ / ยังไม่ตั้งค่าช่องทางตรวจสอบ → Pending Verification (ห้ามเติมเครดิตอัตโนมัติ)
    await db
      .prepare(
        `UPDATE topups SET status = 'pending', verification_source = 'none', review_note = ?
         WHERE id = ? AND status = 'verifying'`,
      )
      .bind(`ไม่สามารถตรวจสอบอัตโนมัติได้: ${redeemed.message} — รอแอดมินตรวจสอบหลักฐาน`, topupId)
      .run();
    await db
      .prepare(
        `INSERT INTO topup_verifications (topup_id, actor_name, action, amount, evidence, note)
         VALUES (?, 'system', 'verification_unavailable', 0, ?, ?)`,
      )
      .bind(topupId, redeemed.message, 'Not Configured / ติดต่อผู้ให้บริการไม่ได้ — ส่งต่อแอดมินตรวจด้วยตนเอง')
      .run();

    return json(
      {
        ok: true,
        auto: false,
        pending: true,
        status: 'pending',
        verification: relayConfigured ? 'unavailable' : 'not_configured',
        topup: {
          id: topupId,
          method,
          status: 'pending',
          amount: declared.amount,
          fee: declared.fee,
          net: declared.net,
          declaredAmount: declared.amount,
        },
        message: `ระบบยังตรวจสอบซองอัตโนมัติไม่ได้ (${redeemed.message}) — บันทึกเป็น "รอตรวจสอบ" แล้ว แอดมินจะตรวจยอดจริงและเติมเครดิตให้ ยังไม่มีการเพิ่มเครดิตในขั้นตอนนี้`,
      },
      201,
    );
  }

  const split = splitFee(amount, FEE_PERCENT);
  const result = await db
    .prepare(
      `INSERT INTO topups (user_id, method, amount, fee, net, reference, note, status, declared_amount, verification_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'manual')`,
    )
    .bind(user.id, method, split.amount, split.fee, split.net, reference, note, split.amount)
    .run();

  return json(
    {
      ok: true,
      auto: false,
      pending: true,
      topup: { id: result.meta.last_row_id, method, amount: split.amount, fee: split.fee, net: split.net, status: 'pending' },
      message: `แจ้งเติมเงิน ฿${split.amount.toFixed(2)} แล้ว รอแอดมินตรวจสอบ — รับจริง ฿${split.net.toFixed(2)} (หัก ${FEE_PERCENT}% = ฿${split.fee.toFixed(2)})`,
    },
    201,
  );
}

async function listMyTopups(ctx) {
  const user = requireUser(ctx);
  const settings = await getSettings(ctx.db);
  const rows = await ctx.db
    .prepare(
      `SELECT id, method, amount, fee, net, declared_amount, reference, status, created_at, review_note,
              reviewed_by, reviewed_at, voucher_code, verification_source, balance_after
       FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT 60`,
    )
    .bind(user.id)
    .all();
  return json({
    feePercent: FEE_PERCENT,
    verification: {
      mode: ctx.env.TRUEMONEY_RELAY_URL ? 'relay' : 'unconfigured',
      configured: Boolean(ctx.env.TRUEMONEY_RELAY_URL),
      message: ctx.env.TRUEMONEY_RELAY_URL
        ? 'ระบบตรวจสอบซองอัตโนมัติผ่าน relay ของร้าน'
        : 'ยังไม่ได้เชื่อมต่อผู้ให้บริการตรวจสอบซอง — คำขอจะถูกส่งให้แอดมินตรวจสอบด้วยตนเอง',
    },
    payment: {
      ticketPhone: TICKET_PHONE,
      bank: {
        name: settings.bank_name || '',
        account: settings.bank_account || '',
        holder: settings.bank_holder || '',
      },
      note: settings.topup_note || '',
    },
    topups: rows.results.map(topupView),
  });
}

/* ------------------------------------------------------------------ */
/* support tickets                                                     */
/* ------------------------------------------------------------------ */

async function createTicket(ctx) {
  const { db, request } = ctx;
  const user = requireUser(ctx);
  await enforceRate(db, `ticket:${user.id}`, 5, 10 * 60 * 1000);
  const body = await readJson(request, 4096);
  const subject = str(body.subject, { label: 'หัวข้อ', min: 3, max: 80 });
  const message = str(body.message, { label: 'รายละเอียด', min: 5, max: 1000 });
  await db
    .prepare('INSERT INTO tickets (user_id, subject, message) VALUES (?, ?, ?)')
    .bind(user.id, subject, message)
    .run();
  return json({ ok: true, message: 'ส่งเรื่องถึงแอดมินแล้ว' }, 201);
}

async function listMyTickets(ctx) {
  const user = requireUser(ctx);
  const rows = await ctx.db
    .prepare(
      `SELECT id, subject, message, status, created_at, reply, replied_at
       FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 40`,
    )
    .bind(user.id)
    .all();
  return json({ tickets: rows.results });
}

/* ------------------------------------------------------------------ */
/* ตัวแทน/ตัวขาย (frontend) + API ซื้อคีย์                            */
/* ------------------------------------------------------------------ */

function resellerStatusView(profile, user) {
  const status = profile ? profile.status : 'none';
  const feeUntil = sqliteTime(profile?.fee_paid_until);
  const feeDue = Boolean(profile && profile.status === 'active' && feeUntil && feeUntil < Date.now());
  return {
    status,
    role: user.role,
    feeDue,
    daysLeft: feeUntil ? Math.max(0, Math.ceil((feeUntil - Date.now()) / 86400000)) : 0,
    apiEnabled: status === 'active' && user.role === 'dealer',
    canApply: roleRank(user.role) >= ROLES.dealer.rank && (!profile || ['rejected', 'revoked'].includes(status)),
    rules: {
      fee: RESELLER_FEE,
      weeklyTarget: RESELLER_WEEKLY_TARGET,
      monthlyTarget: RESELLER_MONTHLY_TARGET,
      trialDays: RESELLER_TRIAL_DAYS,
    },
  };
}

function resellerProfileView(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    status: profile.status,
    contact: profile.contact,
    note: profile.note,
    startedAt: profile.started_at,
    feePaidUntil: profile.fee_paid_until,
    reviewNote: profile.review_note,
    createdAt: profile.created_at,
  };
}

async function resellerSummary(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  const profile = await evaluateReseller(db, user);
  const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  const stats = await resellerSales(db, user.id);
  const keys = await db
    .prepare(
      'SELECT id, name, prefix, last_used_at, created_at FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY id DESC LIMIT 10',
    )
    .bind(user.id)
    .all();
  return json({
    user: publicUser(fresh),
    profile: resellerProfileView(profile),
    ...resellerStatusView(profile, fresh),
    sales: stats,
    keys: keys.results,
    endpoints: {
      products: '/api/v1/products',
      purchase: '/api/v1/purchase',
    },
  });
}

async function resellerApply(ctx) {
  const db = ctx.db;
  const user = requireUser(ctx);
  await enforceRate(db, `reseller:${user.id}`, 3, 60 * 60 * 1000);
  const body = await readJson(ctx.request, 2048);
  if (body.agree !== true) throw new HttpError(400, 'กรุณายอมรับเงื่อนไขตัวแทนก่อนสมัคร');
  if (roleRank(user.role) <= STAFF_RANK) throw new HttpError(400, 'บัญชีแอดมินไม่ต้องสมัครตัวแทน');
  const contact = str(body.contact, { label: 'ช่องทางติดต่อ', min: 3, max: 60 });
  const note = str(body.note, { label: 'หมายเหตุ', max: 200, required: false });

  const existing = await db.prepare('SELECT * FROM reseller_profiles WHERE user_id = ?').bind(user.id).first();
  if (existing && ['pending', 'active', 'suspended'].includes(existing.status)) {
    throw new HttpError(400, 'มีใบสมัครหรือสถานะตัวแทนอยู่แล้ว');
  }
  if (existing) {
    await db
      .prepare(
        "UPDATE reseller_profiles SET status = 'pending', contact = ?, note = ?, review_note = '', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?",
      )
      .bind(contact, note, existing.id)
      .run();
  } else {
    await db
      .prepare("INSERT INTO reseller_profiles (user_id, status, contact, note) VALUES (?, 'pending', ?, ?)")
      .bind(user.id, contact, note)
      .run();
  }
  await db.prepare('UPDATE users SET contact = ? WHERE id = ? AND contact = \'\'').bind(contact, user.id).run();
  await audit(db, user, 'reseller.apply', `สมัครตัวแทน/ตัวขาย (${contact})`);
  return json({ ok: true, message: 'ส่งใบสมัครตัวแทนแล้ว รอแอดมินอนุมัติ' }, 201);
}

async function resellerRenew(ctx) {
  const db = ctx.db;
  const user = requireUser(ctx);
  await enforceRate(db, `reseller:renew:${user.id}`, 5, 60 * 60 * 1000);
  const profile = await db.prepare('SELECT * FROM reseller_profiles WHERE user_id = ?').bind(user.id).first();
  if (!profile || !['active', 'suspended'].includes(profile.status)) {
    throw new HttpError(400, 'ยังไม่ได้เป็นตัวแทนที่เปิดใช้งาน');
  }
  const paid = await db
    .prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
    .bind(RESELLER_FEE, user.id, RESELLER_FEE)
    .run();
  if (Number(paid.meta.changes) !== 1) {
    throw new HttpError(400, `เครดิตไม่พอชำระค่าบริการ ${RESELLER_FEE} บาท กรุณาเติมเงินก่อน`);
  }
  await db
    .prepare(
      "UPDATE reseller_profiles SET status = 'active', fee_paid_until = datetime(COALESCE(fee_paid_until, 'now'), '+30 days'), review_note = '' WHERE id = ?",
    )
    .bind(profile.id)
    .run();
  await audit(db, user, 'reseller.renew', `ชำระค่าบริการตัวแทน ${RESELLER_FEE} บาท`);
  return json({ ok: true, message: `ชำระค่าบริการ ${RESELLER_FEE} บาทแล้ว ต่ออายุ 30 วัน` });
}

async function resellerCreateKey(ctx) {
  const db = ctx.db;
  const user = requireUser(ctx);
  await enforceRate(db, `reseller:key:${user.id}`, 8, 60 * 60 * 1000);
  const body = await readJson(ctx.request, 1024);
  const name = str(body.name ?? 'API key', { label: 'ชื่อคีย์', min: 2, max: 40 });
  if (user.role !== 'dealer') throw new HttpError(403, 'ต้องเป็นยศตัวแทน/ตัวขายก่อนสร้าง API key');
  const profile = await evaluateReseller(db, user);
  if (!profile || profile.status !== 'active') throw new HttpError(403, 'สถานะตัวแทนยังไม่พร้อมใช้งาน');
  const count = await db
    .prepare('SELECT COUNT(*) AS total FROM api_keys WHERE user_id = ? AND revoked = 0')
    .bind(user.id)
    .first();
  if (Number(count?.total || 0) >= 5) throw new HttpError(400, 'มี API key ที่ใช้งานอยู่ครบ 5 คีย์แล้ว กรุณายกเลิกคีย์เก่าก่อน');

  const raw = `fk_${randomHex(24)}`;
  const hash = await sha256Hex(raw);
  const prefix = `${raw.slice(0, 11)}…`;
  const result = await db
    .prepare('INSERT INTO api_keys (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?)')
    .bind(user.id, name, hash, prefix)
    .run();
  await audit(db, user, 'reseller.key.create', name);
  return json(
    {
      ok: true,
      key: raw,
      apiKey: { id: result.meta.last_row_id, name, prefix, lastUsedAt: null, createdAt: new Date().toISOString() },
      message: 'สร้าง API key แล้ว — คัดลอกเก็บไว้ทันที ระบบจะแสดงคีย์เต็มเพียงครั้งเดียว',
    },
    201,
  );
}

async function resellerRevokeKey(ctx, id) {
  const user = requireUser(ctx);
  const result = await ctx.db
    .prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0')
    .bind(id, user.id)
    .run();
  if (Number(result.meta.changes) !== 1) throw new HttpError(404, 'ไม่พบ API key นี้');
  await audit(ctx.db, user, 'reseller.key.revoke', `#${id}`);
  return json({ ok: true, message: 'ยกเลิก API key แล้ว' });
}

async function apiDealerProducts(ctx) {
  const user = await dealerFromApiKey(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT p.*, c.name AS category_name FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE p.active = 1 ORDER BY p.id ASC`,
  ).all();
  return json({
    currency: 'THB',
    discountPercent: Math.round(DEALER_DISCOUNT * 100),
    products: rows.results.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category_name,
      price: money(p.price),
      dealerPrice: priceFor(p, user.role),
      stock: Number(p.stock),
      available: Number(p.stock) > 0,
    })),
  });
}

async function apiDealerPurchase(ctx) {
  const db = ctx.db;
  const user = await dealerFromApiKey(ctx);
  const body = await readJson(ctx.request, 2048);
  const productId = num(body.productId, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
  const quantity = num(body.quantity ?? 1, { label: 'จำนวน', min: 1, max: 10, integer: true });
  const result = await purchaseKeys(db, ctx.env, user, productId, quantity);
  return json(
    {
      ok: true,
      ...result,
      apiKey: { id: ctx.apiKey.id, name: ctx.apiKey.name },
    },
    201,
  );
}

/* ------------------------------------------------------------------ */
/* admin                                                               */
/* ------------------------------------------------------------------ */

async function adminOverview(ctx) {
  const db = ctx.env.DB;
  const [revenue, orderCount, userCount, pending, lowStock, recentOrders, recentTopups, roles] =
    await db.batch([
      db.prepare('SELECT COALESCE(SUM(total), 0) AS v FROM orders'),
      db.prepare('SELECT COUNT(*) AS v FROM orders'),
      db.prepare('SELECT COUNT(*) AS v FROM users'),
      db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS amt FROM topups WHERE status = 'pending'"),
      db.prepare('SELECT id, name, stock FROM products WHERE stock <= 5 AND active = 1 ORDER BY stock ASC LIMIT 8'),
      db.prepare(
        `SELECT o.id, o.total, o.created_at, o.product_name, u.username
         FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 8`,
      ),
      db.prepare(
        `SELECT t.id, t.amount, t.net, t.method, t.created_at, u.username
         FROM topups t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 8`,
      ),
      db.prepare('SELECT role, COUNT(*) AS total FROM users GROUP BY role'),
    ]);

  const roleBreakdown = {};
  for (const key of ROLE_KEYS) roleBreakdown[key] = 0;
  for (const row of roles.results) roleBreakdown[row.role] = row.total;

  return json({
    revenue: money(revenue.results[0].v),
    orderCount: orderCount.results[0].v,
    userCount: userCount.results[0].v,
    pendingTopups: {
      count: pending.results[0].c,
      amount: money(pending.results[0].amt),
    },
    lowStock: lowStock.results,
    recentOrders: recentOrders.results,
    recentTopups: recentTopups.results,
    roles: roleBreakdown,
    feePercent: FEE_PERCENT,
    security: await securitySummary(db),
  });
}

async function adminListProducts(ctx) {
  const rows = await ctx.env.DB.prepare(
    `SELECT p.*, c.name AS category_name,
       (SELECT COUNT(*) FROM stock_items s
        WHERE s.product_id = p.id AND s.status = 'available' AND s.code NOT LIKE 'DEMO-%') AS ready_keys,
       (SELECT COUNT(*) FROM stock_items s
        WHERE s.product_id = p.id AND s.code LIKE 'DEMO-%' AND s.status <> 'sold') AS demo_keys,
       (SELECT COUNT(*) FROM stock_items s
        WHERE s.product_id = p.id AND s.status = 'sold') AS sold_keys
     FROM products p
     JOIN categories c ON c.id = p.category_id
     ORDER BY c.sort_order ASC, p.id ASC`,
  ).all();
  return json({
    products: rows.results.map((p) => ({
      ...productView(p, 'member'),
      readyKeys: Number(p.ready_keys || 0),
      demoKeys: Number(p.demo_keys || 0),
      soldKeys: Number(p.sold_keys || 0),
      needsKeys: Number(p.ready_keys || 0) === 0,
    })),
  });
}

async function adminCreateProduct(ctx) {
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, 4096);
  const categoryId = num(body.categoryId, { label: 'หมวดหมู่', min: 1, max: 1e9, integer: true });
  const name = str(body.name, { label: 'ชื่อสินค้า', min: 2, max: 80 });
  const description = str(body.description, { label: 'รายละเอียด', max: 300, required: false });
  const duration = str(body.duration, { label: 'ระยะเวลาการใช้งาน', max: 40, required: false });
  const price = money(num(body.price, { label: 'ราคา', min: 1, max: 100000 }));
  const stock = 0; // สต็อกมาจากคีย์ที่แอดมินเพิ่มเข้าคลังเท่านั้น
  const cat = await db.prepare('SELECT id FROM categories WHERE id = ?').bind(categoryId).first();
  if (!cat) throw new HttpError(404, 'ไม่พบหมวดหมู่นี้');
  const result = await db
    .prepare('INSERT INTO products (category_id, name, description, price, stock, duration) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(categoryId, name, description, price, stock, duration)
    .run();
  await logStaff(ctx, 'product.create', `${name} ฿${price}`);
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function adminUpdateProduct(ctx, id) {
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, 4096);
  const current = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!current) throw new HttpError(404, 'ไม่พบสินค้านี้');

  const next = {
    name: body.name !== undefined ? str(body.name, { label: 'ชื่อสินค้า', min: 2, max: 80 }) : current.name,
    description:
      body.description !== undefined
        ? str(body.description, { label: 'รายละเอียด', max: 300, required: false })
        : current.description,
    price:
      body.price !== undefined
        ? money(num(body.price, { label: 'ราคา', min: 1, max: 100000 }))
        : current.price,
    duration:
      body.duration !== undefined
        ? str(body.duration, { label: 'ระยะเวลาการใช้งาน', max: 40, required: false })
        : current.duration || '',
    stock: current.stock,
    categoryId:
      body.categoryId !== undefined
        ? num(body.categoryId, { label: 'หมวดหมู่', min: 1, max: 1e9, integer: true })
        : current.category_id,
    active:
      body.active !== undefined ? (body.active ? 1 : 0) : Number(current.active),
  };

  if (body.categoryId !== undefined) {
    const cat = await db.prepare('SELECT id FROM categories WHERE id = ?').bind(next.categoryId).first();
    if (!cat) throw new HttpError(404, 'ไม่พบหมวดหมู่นี้');
  }

  await db
    .prepare(
      `UPDATE products SET name = ?, description = ?, price = ?, stock = ?, category_id = ?, active = ?, duration = ?
       WHERE id = ?`,
    )
    .bind(next.name, next.description, next.price, next.stock, next.categoryId, next.active, next.duration, id)
    .run();
  await logStaff(ctx, 'product.update', `#${id} ${next.name} ฿${next.price}`);
  return json({ ok: true });
}

/* ---------- คลังคีย์ (ส่งอัตโนมัติหลังซื้อ) ---------- */

async function upcomingProduct(db, productId) {
  const product = await db.prepare('SELECT id, name FROM products WHERE id = ?').bind(productId).first();
  if (!product) throw new HttpError(404, 'ไม่พบสินค้านี้');
  return product;
}

async function availableCount(db, productId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM stock_items WHERE product_id = ? AND status = 'available' AND code NOT LIKE 'DEMO-%'",
    )
    .bind(productId)
    .first();
  return Number(row?.total || 0);
}

async function demoKeysCount(db, productId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM stock_items WHERE product_id = ? AND code LIKE 'DEMO-%' AND status <> 'sold'",
    )
    .bind(productId)
    .first();
  return Number(row?.total || 0);
}

async function adminListKeys(ctx, id) {
  const db = ctx.env.DB;
  const productId = num(id, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
  const product = await upcomingProduct(db, productId);
  const status = ctx.url.searchParams.get('status') || 'available';
  const filter = ['available', 'sold', 'demo', 'all'].includes(status) ? status : 'available';
  const where =
    filter === 'all'
      ? ''
      : filter === 'available'
        ? "AND status = 'available' AND code NOT LIKE 'DEMO-%'"
        : filter === 'sold'
          ? "AND status = 'sold'"
          : "AND code LIKE 'DEMO-%' AND status <> 'sold'";
  const rows = await db
    .prepare(
      `SELECT id, code, status, order_id, sold_at, created_at FROM stock_items
       WHERE product_id = ? ${where}
       ORDER BY id DESC LIMIT 300`,
    )
    .bind(productId)
    .all();
  return json({
    product: { id: product.id, name: product.name },
    available: await availableCount(db, productId),
    demo: await demoKeysCount(db, productId),
    keys: rows.results.map((key) => ({ ...key, demo: String(key.code).startsWith('DEMO-') })),
  });
}

/** ลบคีย์ตัวอย่าง DEMO- ทั้งหมดของสินค้า (ขายไปแล้วไม่แตะ) */
async function adminDeleteDemoKeys(ctx, id) {
  const db = ctx.env.DB;
  const productId = num(id, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
  const product = await upcomingProduct(db, productId);
  const result = await db
    .prepare("DELETE FROM stock_items WHERE product_id = ? AND code LIKE 'DEMO-%' AND status <> 'sold'")
    .bind(productId)
    .run();
  const removed = Number(result.meta.changes || 0);
  await syncStock(db, productId);
  await logStaff(ctx, 'stock.delete_demo', `${product.name} ลบคีย์ตัวอย่าง ${removed} รายการ`);
  return json({ ok: true, removed, stock: await availableCount(db, productId) });
}

async function adminAddKeys(ctx, id) {
  const db = ctx.env.DB;
  const productId = num(id, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
  const product = await upcomingProduct(db, productId);
  await enforceRate(db, `admin:keys:${ctx.user.id}`, 60, 60 * 1000);
  const body = await readJson(ctx.request, 32768);
  const raw = str(body.keys, { label: 'คีย์', min: 1, max: 20000 });
  const lines = [...new Set(raw.split(/[\r\n,;]+/).map((line) => line.trim()).filter(Boolean))];
  if (!lines.length) throw new HttpError(400, 'กรุณาวางคีย์อย่างน้อย 1 รายการ');
  if (lines.length > 300) throw new HttpError(400, 'เพิ่มได้สูงสุด 300 คีย์ต่อครั้ง');
  for (const code of lines) {
    if (code.length < 3 || code.length > 190) throw new HttpError(400, 'คีย์ต้องมีความยาว 3-190 ตัวอักษร');
    if (/^DEMO-/i.test(code)) throw new HttpError(400, 'ห้ามใช้คำนำหน้า DEMO- เพราะระบบกันไม่ให้ขายคีย์ตัวอย่าง');
  }

  const results = await db.batch(
    lines.map((code) =>
      db
        .prepare(
          "INSERT INTO stock_items (product_id, code) VALUES (?, ?) ON CONFLICT(product_id, code) DO NOTHING",
        )
        .bind(productId, code),
    ),
  );
  const added = results.reduce((sum, res) => sum + Number(res.meta.changes || 0), 0);
  await syncStock(db, productId);
  await logStaff(ctx, 'stock.add', `${product.name} เพิ่ม ${added} คีย์ (ซ้ำ ${lines.length - added})`);
  return json(
    {
      ok: true,
      added,
      skipped: lines.length - added,
      stock: await availableCount(db, productId),
      message: `เพิ่มคีย์ ${added} รายการ${lines.length - added ? ` (ข้ามคีย์ซ้ำ ${lines.length - added})` : ''}`,
    },
    201,
  );
}

async function adminDeleteKey(ctx, id, keyId) {
  const db = ctx.env.DB;
  const productId = num(id, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
  const stockItemId = num(keyId, { label: 'คีย์', min: 1, max: 1e9, integer: true });
  const result = await db
    .prepare("DELETE FROM stock_items WHERE id = ? AND product_id = ? AND status = 'available'")
    .bind(stockItemId, productId)
    .run();
  if (Number(result.meta.changes) !== 1) throw new HttpError(409, 'ลบคีย์นี้ไม่ได้ (ขายไปแล้วหรือไม่พบคีย์)');
  await syncStock(db, productId);
  await logStaff(ctx, 'stock.delete', `ลบคีย์ #${stockItemId} ของสินค้า #${productId}`);
  return json({ ok: true, stock: await availableCount(db, productId) });
}

async function adminDeleteProduct(ctx, id) {
  const result = await ctx.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
  if (Number(result.meta.changes) !== 1) throw new HttpError(404, 'ไม่พบสินค้านี้');
  await logStaff(ctx, 'product.delete', `ลบสินค้า #${id}`);
  return json({ ok: true });
}

async function adminListCategories(ctx) {
  const rows = await ctx.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
     FROM categories c ORDER BY c.sort_order ASC, c.id ASC`,
  ).all();
  return json({ categories: rows.results });
}

async function adminCreateCategory(ctx) {
  const body = await readJson(ctx.request, 2048);
  const name = str(body.name, { label: 'ชื่อหมวดหมู่', min: 2, max: 40 });
  const description = str(body.description, { label: 'รายละเอียด', max: 160, required: false });
  const sortOrder = num(body.sortOrder ?? 100, { label: 'ลำดับ', min: 0, max: 9999, integer: true });
  try {
    const result = await ctx.env.DB.prepare(
      'INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)',
    )
      .bind(name, description, sortOrder)
      .run();
    await logStaff(ctx, 'category.create', name);
    return json({ ok: true, id: result.meta.last_row_id }, 201);
  } catch {
    throw new HttpError(409, 'ชื่อหมวดหมู่นี้มีอยู่แล้ว');
  }
}

async function adminUpdateCategory(ctx, id) {
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, 2048);
  const current = await db.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
  if (!current) throw new HttpError(404, 'ไม่พบหมวดหมู่นี้');
  const name = body.name !== undefined ? str(body.name, { label: 'ชื่อหมวดหมู่', min: 2, max: 40 }) : current.name;
  const description =
    body.description !== undefined
      ? str(body.description, { label: 'รายละเอียด', max: 160, required: false })
      : current.description;
  const sortOrder =
    body.sortOrder !== undefined
      ? num(body.sortOrder, { label: 'ลำดับ', min: 0, max: 9999, integer: true })
      : current.sort_order;
  await db
    .prepare('UPDATE categories SET name = ?, description = ?, sort_order = ? WHERE id = ?')
    .bind(name, description, sortOrder, id)
    .run();
  await logStaff(ctx, 'category.update', `#${id} ${name}`);
  return json({ ok: true });
}

async function adminDeleteCategory(ctx, id) {
  const db = ctx.env.DB;
  const count = await db
    .prepare('SELECT COUNT(*) AS total FROM products WHERE category_id = ?')
    .bind(id)
    .first();
  if (Number(count.total) > 0) throw new HttpError(400, 'ลบไม่ได้ เพราะยังมีสินค้าอยู่ในหมวดนี้');
  const result = await db.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
  if (Number(result.meta.changes) !== 1) throw new HttpError(404, 'ไม่พบหมวดหมู่นี้');
  await logStaff(ctx, 'category.delete', `ลบหมวดหมู่ #${id}`);
  return json({ ok: true });
}

async function adminListTopups(ctx) {
  const status = ctx.url.searchParams.get('status') || 'pending';
  const allowed = ['pending', 'approved', 'rejected', 'all'];
  const filter = allowed.includes(status) ? status : 'pending';
  const rows = await ctx.env.DB.prepare(
    `SELECT t.*, u.username, u.balance
     FROM topups t JOIN users u ON u.id = t.user_id
     ${filter === 'all' ? '' : 'WHERE t.status = ?'}
     ORDER BY t.id DESC LIMIT 100`,
  )
    .bind(...(filter === 'all' ? [] : [filter]))
    .all();
  return json({
    feePercent: FEE_PERCENT,
    topups: rows.results.map((t) => ({
      id: t.id,
      userId: t.user_id,
      username: t.username,
      method: t.method,
      amount: money(t.amount),
      fee: money(t.fee),
      net: money(t.net),
      reference: t.reference,
      note: t.note,
      status: t.status,
      createdAt: t.created_at,
      reviewedAt: t.reviewed_at,
      reviewNote: t.review_note,
    })),
  });
}

async function adminReviewTopup(ctx, id) {
  const db = ctx.env.DB;
  const topupId = Number(id);
  const body = await readJson(ctx.request, 4096);
  const action = str(body.action, { label: 'การทำรายการ', min: 5, max: 10 });
  if (!['approve', 'reject', 'reverify'].includes(action)) throw new HttpError(400, 'การทำรายการไม่ถูกต้อง');
  const note = str(body.note, { label: 'หมายเหตุ', max: 300, required: false });
  const evidence = str(body.evidence, { label: 'หลักฐานการตรวจสอบ', max: 500, required: false });

  const topup = await db.prepare('SELECT * FROM topups WHERE id = ?').bind(topupId).first();
  if (!topup) throw new HttpError(404, 'ไม่พบรายการเติมเงิน');
  if (!['pending', 'verifying'].includes(topup.status)) {
    throw new HttpError(409, `รายการนี้ถูกตรวจสอบไปแล้ว (สถานะ ${topup.status})`);
  }

  const logVerification = async (verificationAction, amount, extraNote) => {
    await db
      .prepare(
        `INSERT INTO topup_verifications (topup_id, actor_id, actor_name, action, amount, evidence, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        topupId,
        ctx.user.id,
        ctx.user.username,
        verificationAction,
        amount,
        String(evidence || '').slice(0, 500),
        String(extraNote || '').slice(0, 300),
      )
      .run();
  };

  if (action === 'reverify') {
    await db.prepare("UPDATE topups SET status = 'verifying' WHERE id = ? AND status = 'pending'").bind(topupId).run();
    await logVerification('manual_review_started', 0, note || 'แอดมินเริ่มตรวจสอบหลักฐาน');
    await logStaff(ctx, 'topup.reverify', `#${topupId} เริ่มตรวจสอบ`);
    return json({ ok: true, status: 'verifying' });
  }

  if (action === 'reject') {
    if (note.trim().length < 3) throw new HttpError(400, 'กรุณาระบุเหตุผลในการปฏิเสธอย่างน้อย 3 ตัวอักษร');
    const result = await db
      .prepare(
        `UPDATE topups SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
         WHERE id = ? AND status IN ('pending', 'verifying')`,
      )
      .bind(ctx.user.id, note, topupId)
      .run();
    if (Number(result.meta.changes) !== 1) throw new HttpError(409, 'รายการนี้ถูกตรวจสอบไปแล้ว');
    await logVerification('reject', 0, note);
    await logStaff(ctx, 'topup.reject', `#${topupId} ฿${money(topup.amount)} — ${note}`);
    if (topup.method === 'envelope' && topup.voucher_code) {
      await db
        .prepare(
          `UPDATE gift_envelope_transactions SET status = 'rejected' WHERE voucher_code = ? AND status = 'pending'`,
        )
        .bind(topup.voucher_code)
        .run();
    }
    return json({ ok: true, status: 'rejected', note });
  }

  // ---------- approve (ตรวจสอบด้วยแอดมิน) ----------
  // ยอดจริงต้องมาจากการตรวจสอบ ไม่เชื่อยอดที่สมาชิกกรอก — แอดมินต้องยืนยันยอดจริง
  const actual =
    body.amount === undefined || body.amount === null || body.amount === ''
      ? money(topup.declared_amount || topup.amount)
      : num(body.amount, { label: 'ยอดเงินจริงในซอง', min: 1, max: 200000 });
  const split = splitFee(actual, FEE_PERCENT);
  if (!(split.amountSatang > 0)) throw new HttpError(400, 'ยอดเงินจริงไม่ถูกต้อง');

  // 1) จองสถานะก่อน → กันการอนุมัติซ้ำพร้อมกัน
  const claimed = await db
    .prepare(
      `UPDATE topups SET status = 'approved', amount = ?, fee = ?, net = ?, reviewed_by = ?,
         reviewed_at = datetime('now'), review_note = ?, verification_source = 'manual'
       WHERE id = ? AND status IN ('pending', 'verifying')`,
    )
    .bind(split.amount, split.fee, split.net, ctx.user.id, note || 'แอดมินตรวจสอบยอดจริงแล้ว', topupId)
    .run();
  if (Number(claimed.meta.changes) !== 1) throw new HttpError(409, 'รายการนี้ถูกตรวจสอบไปแล้ว');

  // 2) หนึ่งซอง = หนึ่งครั้ง (UNIQUE ที่ฐานข้อมูล)
  if (topup.method === 'envelope' && topup.voucher_code) {
    try {
      await db
        .prepare(
          `INSERT INTO gift_envelope_transactions (topup_id, voucher_code, phone, amount, status, source, raw_response)
           VALUES (?, ?, ?, ?, 'approved', 'manual', ?)`,
        )
        .bind(topupId, topup.voucher_code, TICKET_PHONE, split.amount, String(evidence || note || '').slice(0, 900))
        .run();
    } catch {
      await db
        .prepare("UPDATE topups SET status = 'duplicate', review_note = ? WHERE id = ?")
        .bind('ซองนี้เคยถูกเพิ่มเครดิตในระบบแล้ว — ปฏิเสธเพื่อกันเครดิตซ้ำ', topupId)
        .run();
      await logVerification('duplicate_blocked', 0, 'voucher ซ้ำ');
      throw new HttpError(409, 'ซองนี้เคยเพิ่มเครดิตในระบบแล้ว ไม่สามารถอนุมัติซ้ำได้');
    }
  }

  // 3) เพิ่มเครดิตแบบ idempotent + บันทึกกระเป๋า
  const credit = await creditWallet(db, {
    userId: topup.user_id,
    amountSatang: split.netSatang,
    kind: 'topup',
    refType: 'topup',
    refId: topupId,
    note: `${topup.method === 'envelope' ? 'ซองทรู' : 'โอนธนาคาร'} ฿${split.amount.toFixed(2)} (ค่าธรรมเนียม ${FEE_PERCENT}%) โดย ${ctx.user.username}`,
    idempotencyKey: `topup:${topupId}`,
    actorId: ctx.user.id,
  });
  if (!credit.credited) {
    await db
      .prepare("UPDATE topups SET status = 'duplicate', review_note = ? WHERE id = ?")
      .bind('ตรวจพบการเติมเครดิตซ้ำ (idempotency) — ไม่เพิ่มเครดิตอีก', topupId)
      .run();
    await logVerification('duplicate_credit_blocked', 0, 'idempotency ตรงกับธุรกรรมเดิม');
    throw new HttpError(409, 'รายการนี้เคยเติมเครดิตแล้ว ไม่สามารถเติมซ้ำได้');
  }

  await db
    .prepare('UPDATE topups SET balance_after = ? WHERE id = ?')
    .bind(credit.after, topupId)
    .run();
  await logVerification('approve', split.amount, note || 'ตรวจสอบยอดจริงและอนุมัติ');
  await logStaff(
    ctx,
    'topup.approve',
    `#${topupId} ยอดจริง ฿${split.amount.toFixed(2)} หัก ${FEE_PERCENT}% (฿${split.fee.toFixed(2)}) เข้า ฿${split.net.toFixed(2)}`,
  );

  const user = await db.prepare('SELECT balance, email FROM users WHERE id = ?').bind(topup.user_id).first();
  if (user?.email) {
    await sendEmail(ctx.env, db, {
      userId: topup.user_id,
      to: user.email,
      event: 'topup_approved',
      vars: { amount: money(split.amount), net: money(split.net), fee: money(split.fee) },
    });
  }

  return json({
    ok: true,
    status: 'approved',
    amount: split.amount,
    fee: split.fee,
    net: split.net,
    feePercent: FEE_PERCENT,
    balanceBefore: credit.before,
    balanceAfter: credit.after,
    balance: money(user?.balance || 0),
    message: `ยืนยันยอดจริง ฿${split.amount.toFixed(2)} — ค่าธรรมเนียม ${FEE_PERCENT}% (฿${split.fee.toFixed(2)}) — เติมเครดิต ฿${split.net.toFixed(2)}`,
  });
}

async function adminListUsers(ctx) {
  const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 40);
  const rows = await ctx.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.balance, u.is_root, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
            (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.user_id = u.id) AS spent
     FROM users u
     ${q ? 'WHERE u.username LIKE ?' : ''}
     ORDER BY u.is_root DESC, u.id ASC LIMIT 200`,
  )
    .bind(...(q ? [`%${q}%`] : []))
    .all();
  return json({
    users: rows.results.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      roleLabel: ROLES[u.role]?.label || u.role,
      balance: money(u.balance),
      isRoot: Number(u.is_root) === 1,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      orderCount: u.order_count,
      spent: money(u.spent),
    })),
  });
}

async function adminUpdateRole(ctx, id) {
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, 1024);
  const role = str(body.role, { label: 'ยศ', min: 4, max: 8 });
  if (!ROLE_KEYS.includes(role)) throw new HttpError(400, 'ยศไม่ถูกต้อง');
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้นี้');
  if (Number(target.is_root) === 1) throw new HttpError(403, 'ไม่สามารถเปลี่ยนยศบัญชี Owner สูงสุดได้');
  if (target.id === ctx.user.id) throw new HttpError(400, 'ไม่สามารถเปลี่ยนยศของตัวเองได้');

  await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  await logStaff(ctx, 'user.role', `${target.username}: ${target.role} → ${role}`);
  return json({ ok: true, role, roleLabel: ROLES[role].label });
}

async function adminUpdateSettings(ctx) {
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, 4096);
  const updates = {};
  if (body.bankName !== undefined) updates.bank_name = str(body.bankName, { label: 'ชื่อธนาคาร', min: 2, max: 60 });
  if (body.bankAccount !== undefined)
    updates.bank_account = str(body.bankAccount, {
      label: 'เลขบัญชี',
      min: 4,
      max: 40,
      pattern: /^[0-9-\s]+$/,
    });
  if (body.bankHolder !== undefined)
    updates.bank_holder = str(body.bankHolder, { label: 'ชื่อบัญชี', min: 2, max: 60 });
  if (body.storeName !== undefined) updates.store_name = str(body.storeName, { label: 'ชื่อร้าน', min: 2, max: 40 });
  if (body.tagline !== undefined) updates.store_tagline = str(body.tagline, { label: 'สโลแกน', max: 120, required: false });
  if (body.topupNote !== undefined)
    updates.topup_note = str(body.topupNote, { label: 'หมายเหตุการเติมเงิน', max: 200, required: false });

  const keys = Object.keys(updates);
  if (keys.length === 0) throw new HttpError(400, 'ไม่มีข้อมูลให้บันทึก');

  for (const key of keys) {
    await db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, updates[key])
      .run();
  }
  await logStaff(ctx, 'settings.update', keys.join(', '));
  return json({ ok: true, updated: keys });
}

async function adminListTickets(ctx) {
  const rows = await ctx.env.DB.prepare(
    `SELECT t.*, u.username FROM tickets t JOIN users u ON u.id = t.user_id
     ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.id DESC LIMIT 100`,
  ).all();
  return json({ tickets: rows.results });
}

async function adminReplyTicket(ctx, id) {
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, 4096);
  const reply = str(body.reply, { label: 'คำตอบ', min: 2, max: 1000 });
  const result = await db
    .prepare(
      `UPDATE tickets SET reply = ?, replied_by = ?, replied_at = datetime('now'), status = 'answered'
       WHERE id = ?`,
    )
    .bind(reply, ctx.user.id, id)
    .run();
  if (Number(result.meta.changes) !== 1) throw new HttpError(404, 'ไม่พบเรื่องนี้');
  await logStaff(ctx, 'ticket.reply', `#${id}`);
  const ticket = await db
    .prepare('SELECT t.user_id, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?')
    .bind(id)
    .first();
  if (ticket?.email) {
    await sendEmail(ctx.env, db, {
      userId: ticket.user_id,
      to: ticket.email,
      event: 'ticket_reply',
      vars: { ticketId: id, reply },
    });
  }
  return json({ ok: true });
}

async function adminLogs(ctx) {
  const rows = await ctx.env.DB.prepare(
    'SELECT id, actor_name, action, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT 60',
  ).all();
  return json({ logs: rows.results });
}

async function adminListResellers(ctx) {
  const rows = await ctx.env.DB.prepare(
    `SELECT r.*, u.username, u.role, u.balance, u.contact AS user_contact,
       (SELECT COALESCE(SUM(o.total), 0) FROM orders o
        WHERE o.user_id = r.user_id AND o.created_at >= datetime('now', '-7 days')) AS weekly,
       (SELECT COALESCE(SUM(o.total), 0) FROM orders o
        WHERE o.user_id = r.user_id AND o.created_at >= datetime('now', '-30 days')) AS monthly,
       (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = r.user_id AND k.revoked = 0) AS active_keys
     FROM reseller_profiles r JOIN users u ON u.id = r.user_id
     ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC LIMIT 100`,
  ).all();
  return json({
    fee: RESELLER_FEE,
    weeklyTarget: RESELLER_WEEKLY_TARGET,
    monthlyTarget: RESELLER_MONTHLY_TARGET,
    trialDays: RESELLER_TRIAL_DAYS,
    resellers: rows.results.map((r) => ({
      ...resellerProfileView(r),
      userId: r.user_id,
      username: r.username,
      role: r.role,
      roleLabel: ROLES[r.role]?.label || r.role,
      balance: money(r.balance),
      contact: r.contact || r.user_contact || '',
      weekly: money(r.weekly),
      monthly: money(r.monthly),
      activeKeys: Number(r.active_keys || 0),
    })),
  });
}

async function adminReviewReseller(ctx, id) {
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, 2048);
  const action = str(body.action, { label: 'การดำเนินการ', min: 4, max: 12 });
  if (!['approve', 'reject', 'revoke'].includes(action)) throw new HttpError(400, 'การดำเนินการไม่ถูกต้อง');
  const note = str(body.note, { label: 'หมายเหตุ', max: 200, required: false });
  const profile = await db.prepare('SELECT * FROM reseller_profiles WHERE id = ?').bind(id).first();
  if (!profile) throw new HttpError(404, 'ไม่พบใบสมัครตัวแทน');
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(profile.user_id).first();
  if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้ของใบสมัครนี้');

  if (action === 'approve') {
    if (roleRank(target.role) <= STAFF_RANK) throw new HttpError(400, 'บัญชีนี้เป็นแอดมินอยู่แล้ว');
    const paid = await db
      .prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
      .bind(RESELLER_FEE, target.id, RESELLER_FEE)
      .run();
    if (Number(paid.meta.changes) !== 1) {
      throw new HttpError(400, `เครดิตของผู้สมัครไม่พอชำระค่าบริการ ${RESELLER_FEE} บาท — ให้เติมเงินก่อนอนุมัติ`);
    }
    await db.batch([
      db.prepare("UPDATE users SET role = 'dealer' WHERE id = ?").bind(target.id),
      db
        .prepare(
          "UPDATE reseller_profiles SET status = 'active', started_at = datetime('now'), fee_paid_until = datetime('now', '+30 days'), review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
        )
        .bind(note, ctx.user.id, profile.id),
    ]);
    await audit(db, ctx.user, 'reseller.approve', `${target.username} → ตัวแทน (หักค่าบริการ ${RESELLER_FEE} บาท)`);
    return json({ ok: true, message: `อนุมัติ ${target.username} เป็นตัวแทนแล้ว (หักค่าบริการ ${RESELLER_FEE} บาท)` });
  }

  if (action === 'reject') {
    await db
      .prepare(
        "UPDATE reseller_profiles SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      )
      .bind(note || 'ใบสมัครไม่ผ่านการอนุมัติ', ctx.user.id, profile.id)
      .run();
    await audit(db, ctx.user, 'reseller.reject', `${target.username} ${note}`);
    return json({ ok: true, message: `ปฏิเสธใบสมัครของ ${target.username} แล้ว` });
  }

  await db.batch([
    db.prepare("UPDATE users SET role = 'member' WHERE id = ? AND role = 'dealer'").bind(target.id),
    db
      .prepare(
        "UPDATE reseller_profiles SET status = 'revoked', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      )
      .bind(note || 'ถูกปลดโดยแอดมิน', ctx.user.id, profile.id),
    db.prepare('UPDATE api_keys SET revoked = 1 WHERE user_id = ?').bind(target.id),
  ]);
  await audit(db, ctx.user, 'reseller.revoke', `${target.username} ${note || 'ถูกปลดโดยแอดมิน'}`);
  return json({ ok: true, message: `ปลด ${target.username} เป็น member และยกเลิก API key แล้ว` });
}

/* ------------------------------------------------------------------ */
/* คูปอง — จัดการโดยแอดมิน                                            */
/* ------------------------------------------------------------------ */

function couponView(c) {
  const nowMs = Date.now();
  const startsRaw = c.starts_at || '';
  const expiresRaw = c.expires_at || '';
  const startsAt = startsRaw ? Date.parse(startsRaw) : NaN;
  const expiresAt = expiresRaw ? Date.parse(expiresRaw) : NaN;
  const active = Number(c.active) === 1;
  const usedUp = Number(c.max_uses) > 0 && Number(c.used_count) >= Number(c.max_uses);
  const expired = !Number.isNaN(expiresAt) && expiresAt < nowMs;
  const scheduled = !Number.isNaN(startsAt) && startsAt > nowMs;
  return {
    id: c.id,
    code: c.code,
    type: c.type === 'fixed' ? 'fixed' : 'percent',
    value: money(c.value),
    maxUses: Number(c.max_uses),
    perUserLimit: Number(c.per_user_limit),
    minSpend: money(c.min_spend),
    productId: c.product_id ? Number(c.product_id) : null,
    categoryId: c.category_id ? Number(c.category_id) : null,
    productName: c.product_name || '',
    categoryName: c.category_name || '',
    startsAt: startsRaw,
    expiresAt: expiresRaw,
    active,
    usedCount: Number(c.used_count),
    usageCount: Number(c.usage_count || c.used_count || 0),
    discountTotal: money(c.discount_total || 0),
    status: !active ? 'disabled' : expired ? 'expired' : usedUp ? 'used_up' : scheduled ? 'scheduled' : 'active',
    createdAt: c.created_at,
  };
}

function couponDate(raw, endOfDay) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const iso = dateOnly.test(text) ? `${text}T${endOfDay ? '23:59:59' : '00:00:00'}` : text;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) throw new HttpError(400, 'รูปแบบวันที่ไม่ถูกต้อง');
  const date = new Date(parsed);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function couponInput(body) {
  const code = normalizeCouponCode(str(body.code, { label: 'โค้ดคูปอง', min: 2, max: 32 }));
  if (!/^[A-Z0-9_-]+$/.test(code)) throw new HttpError(400, 'โค้ดคูปองใช้ได้เฉพาะ A-Z, 0-9, - และ _ เท่านั้น');
  const type = String(body.type) === 'fixed' ? 'fixed' : 'percent';
  const value = money(num(body.value, { label: 'จำนวนส่วนลด', min: 0.01, max: 100000 }));
  if (type === 'percent' && value > 100) throw new HttpError(400, 'ส่วนลดแบบเปอร์เซ็นต์ต้องไม่เกิน 100');
  const maxUses = num(body.maxUses ?? 0, { label: 'จำนวนครั้งที่ใช้ได้', min: 0, max: 100000, integer: true });
  const perUserLimit = num(body.perUserLimit ?? 1, { label: 'จำกัดสิทธิ์ต่อสมาชิก', min: 0, max: 1000, integer: true });
  const minSpend = money(num(body.minSpend ?? 0, { label: 'ยอดซื้อขั้นต่ำ', min: 0, max: 1000000 }));
  const productId = body.productId ? num(body.productId, { label: 'สินค้า', min: 1, max: 1e9, integer: true }) : null;
  const categoryId = body.categoryId ? num(body.categoryId, { label: 'หมวดหมู่', min: 1, max: 1e9, integer: true }) : null;
  if (productId && categoryId) throw new HttpError(400, 'เลือกเงื่อนไขได้อย่างใดอย่างหนึ่ง: สินค้า หรือ หมวดหมู่');
  const startsAt = couponDate(body.startsAt, false);
  const expiresAt = couponDate(body.expiresAt, true);
  if (startsAt && expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw new HttpError(400, 'วันหมดอายุต้องอยู่หลังวันเริ่มต้น');
  }
  const active = body.active === false || Number(body.active) === 0 ? 0 : 1;
  return { code, type, value, maxUses, perUserLimit, minSpend, productId, categoryId, startsAt, expiresAt, active };
}

async function adminListCoupons(ctx) {
  const rows = await ctx.env.DB.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM coupon_usages u WHERE u.coupon_id = c.id) AS usage_count,
       (SELECT COALESCE(SUM(u.discount), 0) FROM coupon_usages u WHERE u.coupon_id = c.id) AS discount_total,
       p.name AS product_name, cat.name AS category_name
     FROM coupons c
     LEFT JOIN products p ON p.id = c.product_id
     LEFT JOIN categories cat ON cat.id = c.category_id
     ORDER BY c.id DESC LIMIT 200`,
  ).all();
  return json({ coupons: rows.results.map(couponView), now: Date.now() });
}

async function adminCreateCoupon(ctx) {
  const db = ctx.env.DB;
  const input = couponInput(await readJson(ctx.request, 4096));
  const exists = await db.prepare('SELECT id FROM coupons WHERE code = ? COLLATE NOCASE').bind(input.code).first();
  if (exists) throw new HttpError(409, 'มีโค้ดคูปองนี้อยู่แล้ว');
  if (input.productId) {
    const product = await db.prepare('SELECT id FROM products WHERE id = ?').bind(input.productId).first();
    if (!product) throw new HttpError(404, 'ไม่พบสินค้าที่เลือก');
  }
  if (input.categoryId) {
    const category = await db.prepare('SELECT id FROM categories WHERE id = ?').bind(input.categoryId).first();
    if (!category) throw new HttpError(404, 'ไม่พบหมวดหมู่ที่เลือก');
  }
  const result = await db
    .prepare(
      `INSERT INTO coupons (code, type, value, max_uses, per_user_limit, min_spend, product_id, category_id, starts_at, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.code,
      input.type,
      input.value,
      input.maxUses,
      input.perUserLimit,
      input.minSpend,
      input.productId,
      input.categoryId,
      input.startsAt,
      input.expiresAt,
      input.active,
    )
    .run();
  await logStaff(ctx, 'coupon.create', `${input.code} ${input.type} ${input.value}`);
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function adminUpdateCoupon(ctx, id) {
  const db = ctx.env.DB;
  const current = await db.prepare('SELECT * FROM coupons WHERE id = ?').bind(id).first();
  if (!current) throw new HttpError(404, 'ไม่พบคูปองนี้');
  const body = await readJson(ctx.request, 4096);

  if (body.action === 'toggle') {
    const next = Number(current.active) === 1 ? 0 : 1;
    await db.prepare('UPDATE coupons SET active = ? WHERE id = ?').bind(next, id).run();
    await logStaff(ctx, 'coupon.toggle', `#${id} ${current.code} → ${next ? 'เปิด' : 'ปิด'}`);
    return json({ ok: true, active: Boolean(next) });
  }

  const merged = {
    code: body.code ?? current.code,
    type: body.type ?? current.type,
    value: body.value ?? current.value,
    maxUses: body.maxUses ?? current.max_uses,
    perUserLimit: body.perUserLimit ?? current.per_user_limit,
    minSpend: body.minSpend ?? current.min_spend,
    productId: body.productId === undefined ? current.product_id : body.productId,
    categoryId: body.categoryId === undefined ? current.category_id : body.categoryId,
    startsAt: body.startsAt === undefined ? current.starts_at : body.startsAt,
    expiresAt: body.expiresAt === undefined ? current.expires_at : body.expiresAt,
    active: body.active === undefined ? current.active : body.active,
  };
  const input = couponInput(merged);
  const duplicate = await db
    .prepare('SELECT id FROM coupons WHERE code = ? COLLATE NOCASE AND id <> ?')
    .bind(input.code, id)
    .first();
  if (duplicate) throw new HttpError(409, 'มีโค้ดคูปองนี้อยู่แล้ว');
  await db
    .prepare(
      `UPDATE coupons SET code = ?, type = ?, value = ?, max_uses = ?, per_user_limit = ?, min_spend = ?,
       product_id = ?, category_id = ?, starts_at = ?, expires_at = ?, active = ? WHERE id = ?`,
    )
    .bind(
      input.code,
      input.type,
      input.value,
      input.maxUses,
      input.perUserLimit,
      input.minSpend,
      input.productId,
      input.categoryId,
      input.startsAt,
      input.expiresAt,
      input.active,
      id,
    )
    .run();
  await logStaff(ctx, 'coupon.update', `#${id} ${input.code}`);
  return json({ ok: true });
}

async function adminDeleteCoupon(ctx, id) {
  const db = ctx.env.DB;
  const coupon = await db.prepare('SELECT * FROM coupons WHERE id = ?').bind(id).first();
  if (!coupon) throw new HttpError(404, 'ไม่พบคูปองนี้');
  await db.batch([
    db.prepare('DELETE FROM coupon_usages WHERE coupon_id = ?').bind(id),
    db.prepare('DELETE FROM coupons WHERE id = ?').bind(id),
  ]);
  await logStaff(ctx, 'coupon.delete', `#${id} ${coupon.code}`);
  return json({ ok: true });
}

async function adminCouponUsages(ctx, id) {
  const rows = await ctx.env.DB.prepare(
    `SELECT u.*, us.username, o.product_name
     FROM coupon_usages u
     LEFT JOIN users us ON us.id = u.user_id
     LEFT JOIN orders o ON o.id = u.order_id
     WHERE u.coupon_id = ? ORDER BY u.id DESC LIMIT 200`,
  )
    .bind(id)
    .all();
  return json({
    usages: rows.results.map((u) => ({
      id: u.id,
      username: u.username || `#${u.user_id}`,
      orderId: u.order_id,
      productName: u.product_name || '',
      code: u.code,
      discount: money(u.discount),
      subtotal: money(u.subtotal),
      total: money(u.total),
      createdAt: u.created_at,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* กระเป๋าเงิน (Wallet Ledger) — เฉพาะเจ้าของบัญชี                     */
/* ------------------------------------------------------------------ */

async function myWallet(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  const rows = await db
    .prepare(
      `SELECT id, kind, amount, balance_before, balance_after, ref_type, ref_id, note, created_at
       FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
    )
    .bind(user.id)
    .all();
  const summary = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'topup' THEN amount ELSE 0 END), 0) AS topup_total,
         COALESCE(SUM(CASE WHEN kind = 'purchase' THEN -amount ELSE 0 END), 0) AS spend_total,
         COUNT(*) AS total
       FROM wallet_transactions WHERE user_id = ?`,
    )
    .bind(user.id)
    .first();
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN declared_amount > 0 THEN declared_amount ELSE amount END), 0) AS amt
       FROM topups WHERE user_id = ? AND status IN ('pending', 'verifying')`,
    )
    .bind(user.id)
    .first();
  const fresh = await db.prepare('SELECT balance, points FROM users WHERE id = ?').bind(user.id).first();
  const kindLabels = {
    topup: 'เติมเงิน',
    purchase: 'ซื้อสินค้า',
    refund: 'คืนเงิน',
    adjust: 'ปรับยอดโดยแอดมิน',
    bonus: 'โบนัส',
  };
  return json({
    balance: money(fresh?.balance || 0),
    points: Number(fresh?.points || 0),
    summary: {
      topupTotal: money(summary?.topup_total || 0),
      spendTotal: money(summary?.spend_total || 0),
      transactions: Number(summary?.total || 0),
      pendingCount: Number(pending?.c || 0),
      pendingAmount: money(pending?.amt || 0),
    },
    transactions: rows.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      kindLabel: kindLabels[row.kind] || row.kind,
      amount: money(row.amount),
      direction: row.kind === 'purchase' ? 'out' : 'in',
      balanceBefore: money(row.balance_before),
      balanceAfter: money(row.balance_after),
      refType: row.ref_type,
      refId: row.ref_id,
      note: row.note,
      createdAt: row.created_at,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Admin — TrueMoney Gift Envelope Desk                                */
/* ------------------------------------------------------------------ */

async function adminTopupDesk(ctx) {
  const db = ctx.env.DB;
  const q = String(ctx.url.searchParams.get('q') || '').trim().slice(0, 60);
  const status = String(ctx.url.searchParams.get('status') || 'all');
  const allowedStatus = ['all', 'pending', 'verifying', 'approved', 'rejected', 'expired', 'duplicate'];
  const filter = allowedStatus.includes(status) ? status : 'all';

  const where = ["t.method = 'envelope'"];
  const binds = [];
  if (q) {
    where.push('(u.username LIKE ? OR CAST(t.id AS TEXT) = ? OR t.voucher_code LIKE ? OR t.reference LIKE ?)');
    binds.push(`%${q}%`, q, `%${q}%`, `%${q}%`);
  }
  if (filter !== 'all') {
    where.push('t.status = ?');
    binds.push(filter);
  }

  const rows = await db
    .prepare(
      `SELECT t.*, u.username, u.balance, r.username AS reviewer
       FROM topups t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users r ON r.id = t.reviewed_by
       WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC LIMIT 200`,
    )
    .bind(...binds)
    .all();

  const totals = await db
    .prepare(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(fee), 0) AS fee, COALESCE(SUM(net), 0) AS net
       FROM topups WHERE method = 'envelope' GROUP BY status`,
    )
    .all();
  const approved = totals.results.find((row) => row.status === 'approved') || { c: 0, amount: 0, fee: 0, net: 0 };
  const logs = await db
    .prepare(
      `SELECT v.*, t.voucher_code, u.username AS member
       FROM topup_verifications v
       LEFT JOIN topups t ON t.id = v.topup_id
       LEFT JOIN users u ON u.id = t.user_id
       ORDER BY v.id DESC LIMIT 60`,
    )
    .all();

  return json({
    verification: {
      configured: Boolean(ctx.env.TRUEMONEY_RELAY_URL),
      mode: ctx.env.TRUEMONEY_RELAY_URL ? 'relay' : 'manual',
      status: ctx.env.TRUEMONEY_RELAY_URL ? 'configured' : 'Not Configured',
      message: ctx.env.TRUEMONEY_RELAY_URL
        ? 'ตรวจสอบซองอัตโนมัติผ่าน relay ของร้าน'
        : 'ยังไม่มีช่องทางตรวจสอบที่ได้รับอนุญาต — ใช้การตรวจสอบด้วยแอดมิน',
    },
    totals: {
      approvedCount: Number(approved.c || 0),
      approvedAmount: thb(approved.amount),
      feeTotal: thb(approved.fee),
      netTotal: thb(approved.net),
      pendingCount: Number((totals.results.find((row) => row.status === 'pending') || {}).c || 0),
      statuses: totals.results.map((row) => ({ status: row.status, count: Number(row.c) })),
    },
    topups: rows.results.map((row) => ({
      ...topupView(row),
      username: row.username || '',
      userId: row.user_id,
      reviewer: row.reviewer || '',
      userBalance: money(row.balance || 0),
      hasVoucher: Boolean(row.voucher_code),
    })),
    logs: logs.results.map((row) => ({
      id: row.id,
      topupId: row.topup_id,
      action: row.action,
      actor: row.actor_name || 'system',
      amount: money(row.amount),
      evidence: row.evidence,
      note: row.note,
      voucherCode: row.voucher_code || '',
      member: row.member || '',
      createdAt: row.created_at,
    })),
  });
}

async function adminTopupDetail(ctx, id) {
  const db = ctx.env.DB;
  const topupId = Number(id);
  const row = await db
    .prepare(
      `SELECT t.*, u.username, u.balance, r.username AS reviewer
       FROM topups t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN users r ON r.id = t.reviewed_by
       WHERE t.id = ?`,
    )
    .bind(topupId)
    .first();
  if (!row) throw new HttpError(404, 'ไม่พบรายการเติมเงิน');
  const [logs, wallet, envelope] = await db.batch([
    db.prepare('SELECT * FROM topup_verifications WHERE topup_id = ? ORDER BY id ASC').bind(topupId),
    db
      .prepare('SELECT * FROM wallet_transactions WHERE ref_type = ? AND ref_id = ? ORDER BY id ASC')
      .bind('topup', topupId),
    db.prepare('SELECT * FROM gift_envelope_transactions WHERE topup_id = ?').bind(topupId),
  ]);
  return json({
    topup: {
      ...topupView(row),
      username: row.username || '',
      userId: row.user_id,
      reviewer: row.reviewer || '',
      userBalance: money(row.balance || 0),
      verificationSource: row.verification_source,
      balanceBefore: money(row.balance_before),
      balanceAfter: money(row.balance_after),
      declaredAmount: money(row.declared_amount || row.amount),
    },
    verifications: logs.results.map((log) => ({
      id: log.id,
      action: log.action,
      actor: log.actor_name || 'system',
      amount: money(log.amount),
      evidence: log.evidence,
      note: log.note,
      createdAt: log.created_at,
    })),
    walletTransactions: wallet.results.map((tx) => ({
      id: tx.id,
      kind: tx.kind,
      amount: money(tx.amount),
      balanceBefore: money(tx.balance_before),
      balanceAfter: money(tx.balance_after),
      createdAt: tx.created_at,
    })),
    envelope: envelope.results.map((env) => ({
      voucherCode: env.voucher_code,
      amount: money(env.amount),
      status: env.status,
      source: env.source,
      createdAt: env.created_at,
    })),
  });
}


const ultimate = createUltimate({
  HttpError,
  json,
  readJson,
  str,
  num,
  money,
  requireUser,
  requireStaff,
  requireOwner,
  logStaff,
  roleRank,
  clientIp,
  publicUser,
  getSettings,
  syncStock,
  audit,
  ROLES,
  STAFF_SET,
});

/** ตัวกันสิทธิ์ระดับ route — ตรวจจากฐานข้อมูลทุกครั้ง */
const perm = (name) => async (ctx) => {
  await requirePermission(ctx, name);
};

const routes = [
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/config$/, getConfig],
  ['GET', /^\/api\/captcha$/, getCaptcha],
  ['GET', /^\/api\/gate$/, gateStatus],
  ['POST', /^\/api\/gate$/, gateVerify],
  ['GET', /^\/api\/store$/, getStore],
  ['GET', /^\/api\/live$/, liveState],
  ['POST', /^\/api\/auth\/register$/, register],
  ['POST', /^\/api\/auth\/login$/, login],
  ['POST', /^\/api\/auth\/logout$/, logout],
  ['GET', /^\/api\/me$/, getMe],
  ['POST', /^\/api\/orders$/, createOrder],
  ['GET', /^\/api\/orders$/, listMyOrders],
  ['POST', /^\/api\/coupons\/validate$/, quoteCoupon],
  ['POST', /^\/api\/topups$/, createTopup],
  ['GET', /^\/api\/topups$/, listMyTopups],
  ['GET', /^\/api\/wallet$/, myWallet],
  ['POST', /^\/api\/tickets$/, createTicket],
  ['GET', /^\/api\/tickets$/, listMyTickets],
  ['GET', /^\/api\/reseller$/, resellerSummary],
  ['POST', /^\/api\/reseller\/apply$/, resellerApply],
  ['POST', /^\/api\/reseller\/renew$/, resellerRenew],
  ['POST', /^\/api\/reseller\/keys$/, resellerCreateKey],
  ['DELETE', /^\/api\/reseller\/keys\/(\d+)$/, resellerRevokeKey],
  ['GET', /^\/api\/v1\/products$/, apiDealerProducts],
  ['POST', /^\/api\/v1\/purchase$/, apiDealerPurchase],
  ['GET', /^\/api\/admin\/overview$/, adminOverview, perm('analytics.view')],
  ['GET', /^\/api\/admin\/products$/, adminListProducts],
  ['POST', /^\/api\/admin\/products$/, adminCreateProduct, perm('catalog.manage')],
  ['PATCH', /^\/api\/admin\/products\/(\d+)$/, adminUpdateProduct, perm('catalog.manage')],
  ['DELETE', /^\/api\/admin\/products\/(\d+)$/, adminDeleteProduct, perm('catalog.manage')],
  ['GET', /^\/api\/admin\/products\/(\d+)\/keys$/, adminListKeys, perm('keys.manage')],
  ['POST', /^\/api\/admin\/products\/(\d+)\/keys$/, adminAddKeys, perm('keys.manage')],
  ['DELETE', /^\/api\/admin\/products\/(\d+)\/keys\/(\d+)$/, adminDeleteKey, perm('keys.manage')],
  ['DELETE', /^\/api\/admin\/products\/(\d+)\/demo-keys$/, adminDeleteDemoKeys, perm('keys.manage')],
  ['GET', /^\/api\/admin\/categories$/, adminListCategories],
  ['POST', /^\/api\/admin\/categories$/, adminCreateCategory, perm('catalog.manage')],
  ['PATCH', /^\/api\/admin\/categories\/(\d+)$/, adminUpdateCategory, perm('catalog.manage')],
  ['DELETE', /^\/api\/admin\/categories\/(\d+)$/, adminDeleteCategory, perm('catalog.manage')],
  ['GET', /^\/api\/admin\/topups$/, adminListTopups, perm('wallet.manage')],
  ['GET', /^\/api\/admin\/topups\/envelope$/, adminTopupDesk, perm('wallet.manage')],
  ['GET', /^\/api\/admin\/topups\/(\d+)$/, adminTopupDetail, perm('wallet.manage')],
  ['POST', /^\/api\/admin\/topups\/(\d+)\/review$/, adminReviewTopup, perm('wallet.manage')],
  ['GET', /^\/api\/admin\/coupons$/, adminListCoupons],
  ['POST', /^\/api\/admin\/coupons$/, adminCreateCoupon, perm('coupons.manage')],
  ['PATCH', /^\/api\/admin\/coupons\/(\d+)$/, adminUpdateCoupon, perm('coupons.manage')],
  ['DELETE', /^\/api\/admin\/coupons\/(\d+)$/, adminDeleteCoupon, perm('coupons.manage')],
  ['GET', /^\/api\/admin\/coupons\/(\d+)\/usages$/, adminCouponUsages],
  ['GET', /^\/api\/admin\/users$/, adminListUsers, perm('users.view')],
  ['PATCH', /^\/api\/admin\/users\/(\d+)\/role$/, adminUpdateRole, perm('roles.manage')],
  ['POST', /^\/api\/admin\/settings$/, adminUpdateSettings, perm('settings.manage')],
  ['GET', /^\/api\/admin\/tickets$/, adminListTickets, perm('tickets.view')],
  ['POST', /^\/api\/admin\/tickets\/(\d+)\/reply$/, adminReplyTicket, perm('tickets.reply')],
  ['GET', /^\/api\/admin\/logs$/, adminLogs, perm('audit.view')],
  ['GET', /^\/api\/admin\/resellers$/, adminListResellers, perm('reseller.manage')],
  ['POST', /^\/api\/admin\/resellers\/(\d+)\/review$/, adminReviewReseller, perm('reseller.manage')],
  ...ultimate.routes,
];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'x-xss-protection': '0',
  'x-frame-options': 'SAMEORIGIN',
  // กันสำเนาเว็บ (cache/snippet) โดยไม่ปิดการค้นหาปกติ
  'x-robots-tag': 'noarchive, nosnippet, noimageindex',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'self'; connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com; base-uri 'self'; form-action 'self'",
};

/* ------------------------------------------------------------------ */
/* กันการ dump/mirror เว็บ (bot scraping)                              */
/* ------------------------------------------------------------------ */

const SCRAPER_UA =
  /(curl\/|wget|python-requests|python-urllib|httpx|aiohttp|scrapy|go-http-client|java\/|libwww|node-fetch|axios\/|phantomjs|slimerjs|headlesschrome|puppeteer|playwright|selenium|webdriver|httpie|lwp-|okhttp|masscan|nmap|nikto|sqlmap|zgrab|archive\.org_bot|httrack|wget2)/i;

// เส้นทางที่ต้องผ่านประตูยืนยันตัวตน (เฉพาะคำขอจากเบราว์เซอร์จริง)
const GATED_PATHS = new Set(['/api/store', '/api/auth/register']);

async function banIp(env, ip, reason, hours = 24) {
  const until = Date.now() + hours * 3600 * 1000;
  try {
    await initDb(env);
    await env.DB.prepare(
      `INSERT INTO ip_bans (ip, reason, hits, banned_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, hits = excluded.hits, banned_until = excluded.banned_until`,
    )
      .bind(ip, reason, 99, until)
      .run();
    await audit(env.DB, null, 'security.trap', `${ip} — ${reason}`);
  } catch {
    /* ถ้าบันทึกไม่ได้ก็ปล่อยผ่าน (ชั้นอื่นยังทำงาน) */
  }
}

function blockedResponse(message = 'Forbidden') {
  return withSecurityHeaders(
    new Response(message, {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    }),
  );
}

// ไฟล์นิ่ง (CSS/JS/รูป) แคชได้นานเพื่อให้เว็บโหลดเร็วขึ้น ส่วน HTML ต้องสดเสมอ
const IMMUTABLE_ASSET = /^\/(css|js|img)\//;

function withAssetCache(url, response) {
  if (response.status !== 200) return response;
  const headers = new Headers(response.headers);
  if (IMMUTABLE_ASSET.test(url.pathname)) {
    headers.set(
      'cache-control',
      url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
    );
  } else {
    headers.set('cache-control', 'no-cache');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userAgent = request.headers.get('user-agent') || '';
    const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
    const isApi = url.pathname.startsWith('/api/');

    // กับดักบอท: ลิงก์ซ่อนที่มนุษย์มองไม่เห็น — ใครกดตาม = ถูกแบนทันที
    if (url.pathname === '/__hp' || url.pathname === '/api/__hp') {
      await banIp(env, clientIp(request), 'ตามลิงก์กับดัก (บอทดึงเว็บ)', 24);
      return blockedResponse('Forbidden');
    }

    // บล็อกเครื่องมือ scraping/mirror ที่ไม่ใช่เบราว์เซอร์จริง
    if (SCRAPER_UA.test(userAgent) && (wantsHtml || url.pathname === '/api/store')) {
      return blockedResponse('Forbidden — automated scraping is not allowed');
    }

    if (!isApi) {
      return withSecurityHeaders(withAssetCache(url, await env.ASSETS.fetch(request)));
    }

    const secret = env.SESSION_SECRET || 'firekey-dev-session-secret-please-change';

    const isConfig = request.method === 'GET' && url.pathname === '/api/config';
    let dbReady = true;

    try {
      try {
        await initDb(env);
      } catch (initError) {
        dbReady = false;
        console.error('INIT_DB', initError && initError.stack ? initError.stack : initError);
        // /api/config ใช้ค่าเริ่มต้นได้โดยไม่ต้องพึ่งฐานข้อมูล → ปล่อยให้หน้าเว็บเปิดได้
        if (!isConfig) throw initError;
      }

      // ชั้นป้องกัน DDoS / flood / bot spam — ทุกคำขอ API ต้องผ่านก่อน
      if (dbReady) {
        await guardRequest({ db: env.DB, ip: clientIp(request), method: request.method, url: request.url });
      }

      const cookieHeader = request.headers.get('cookie') || '';
      const cookies = parseCookies(cookieHeader);

      // ประตูยืนยันตัวตน: คำขอจากเบราว์เซอร์ต้องมีตั๋วผ่านประตูก่อน
      // (ตรวจจาก User-Agent ของเบราว์เซอร์จริง เพื่อไม่ให้กระทบ API client/เทสต์)
      const fromBrowser =
        request.headers.has('sec-fetch-mode') && /Mozilla|Chrome|Safari|Firefox|Edg\/|OPR\//i.test(userAgent);
      if (fromBrowser && GATED_PATHS.has(url.pathname)) {
        if (!(await verifyGateToken(secret, cookies[GATE_COOKIE]))) {
          throw new HttpError(403, 'กรุณายืนยันตัวตนว่าไม่ใช่บอทก่อนใช้งาน', { gateRequired: true });
        }
      }

      const session = dbReady ? await readSession(secret, cookies[SESSION_COOKIE]) : null;
      let user = null;
      if (session) {
        user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.uid).first();
        if (user && !ROLES[user.role]) user = null;
      }

      const context = {
        request,
        env,
        db: env.DB,
        url,
        secret,
        user,
        ip: clientIp(request),
      };

      // อัปเดตเวลาออนไลน์ (ไม่เกิน 1 ครั้ง/นาทีต่อผู้ใช้) เพื่อใช้ใน Analytics จริง
      if (user && dbReady && url.pathname !== '/api/live') {
        try {
          await env.DB.prepare(
            "UPDATE users SET online_at = datetime('now') WHERE id = ? AND (online_at IS NULL OR online_at < datetime('now', '-1 minute'))",
          )
            .bind(user.id)
            .run();
        } catch {
          /* ไม่กระทบคำขอหลัก */
        }
      }

      // Maintenance Mode — บล็อกเฉพาะ API ของสมาชิก ทีมงานยังเข้าได้
      if (dbReady && !STAFF_SET.has(user ? user.role : 'guest')) {
        const bypass = new Set(['/api/config', '/api/status', '/api/health', '/api/auth/login', '/api/auth/logout', '/api/captcha', '/api/gate']);
        if (!bypass.has(url.pathname)) {
          const flag = await env.DB.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").first();
          if (flag && String(flag.value) === '1') {
            throw new HttpError(503, 'ร้านปิดปรับปรุงชั่วคราว กรุณากลับมาใหม่ภายหลัง', { maintenance: true });
          }
        }
      }

      for (const [method, pattern, handler, guard] of routes) {
        if (request.method !== method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        if (url.pathname.startsWith('/api/admin/')) await requireStaff(context);
        if (guard) await guard(context);
        const response = await handler(context, match[1], match[2]);
        return withSecurityHeaders(response);
      }

      return withSecurityHeaders(json({ error: 'ไม่พบเส้นทางที่ร้องขอ' }, 404));
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = {};
        if (error.extra && error.extra.retryAfter) headers['retry-after'] = String(error.extra.retryAfter);
        const body = { error: error.message };
        if (error.extra && error.extra.gateRequired) body.gateRequired = true;
        if (error.extra && error.extra.maintenance) body.maintenance = true;
        // Fraud: การยิง API ถี่ผิดปกติ (บันทึกพร้อม IP แต่ไม่ตัดสินจาก IP อย่างเดียว)
        if (error.status === 429) {
          await recordFraud(env.DB, {
            type: 'api_flood',
            risk: 'medium',
            description: `ถูกจำกัดคำขอ: ${url.pathname}`,
            evidence: { path: url.pathname, method: request.method, retryAfter: error.extra?.retryAfter || 0 },
            ip: clientIp(request),
          });
        }
        return withSecurityHeaders(json(body, error.status, headers));
      }
      console.error('UNHANDLED', error && error.stack ? error.stack : error);
      const detail =
        url.pathname === '/api/health' && env.HEALTH_DEBUG === '1'
          ? String((error && (error.stack || error.message)) || error).slice(0, 900)
          : undefined;
      return withSecurityHeaders(
        json({ error: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่', ...(detail ? { detail } : {}) }, 500),
      );
    }
  },
};
