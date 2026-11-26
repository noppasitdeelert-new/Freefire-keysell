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

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const ROLE_KEYS = Object.keys(ROLES);
const STAFF_RANK = ROLES.admin.rank;
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
    isRoot: Number(user.is_root) === 1,
    contact: user.contact,
    createdAt: user.created_at,
  };
}

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบก่อนทำรายการ');
  return ctx.user;
}

function requireStaff(ctx) {
  const user = requireUser(ctx);
  if (roleRank(user.role) > STAFF_RANK) throw new HttpError(403, 'เฉพาะแอดมินขึ้นไปเท่านั้น');
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
  const settings = await getSettings(ctx.env.DB);
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

  const exists = await db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first();
  if (exists) throw new HttpError(409, 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว');

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const result = await db
    .prepare(
      `INSERT INTO users (username, password_hash, salt, role, balance, display_name, contact)
       VALUES (?, ?, ?, 'member', 0, ?, ?)`,
    )
    .bind(username, hash, salt, username, contact)
    .run();

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(result.meta.last_row_id).first();
  const session = await startSession(ctx, user, isSecureRequest(request));
  await audit(db, user, 'register', `สมัครสมาชิกใหม่ (${username})`);
  return json({ user: publicUser(user) }, 201, { 'set-cookie': session.cookie });
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
  if (!safeEqual(hash, user.password_hash)) throw invalid;

  await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();
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
  return json({ user: publicUser(user), pricing: { role: user ? user.role : 'guest' } });
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
async function purchaseKeys(db, user, productId, quantity, clientToken = '', couponCode = '') {
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first();
  if (!product || Number(product.active) !== 1) throw new HttpError(404, 'ไม่พบสินค้านี้');

  const freshUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
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
  const result = await purchaseKeys(db, user, productId, quantity, clientToken, couponCode);
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

/** ดึงรหัสซอง (voucher) จากลิงก์ซองทรู เพื่อกันการแจ้งซองเดิมซ้ำ */
function envelopeVoucherCode(reference) {
  const match = String(reference || '').match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  return match ? match[1] : '';
}

async function createTopup(ctx) {
  const { db, request } = ctx;
  const user = requireUser(ctx);
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

  // ซองเดียวกันแจ้งซ้ำไม่ได้ — กันการใช้ซองเดียวเคลมเครดิตหลายรอบ/หลายคน
  if (method === 'envelope') {
    const voucher = envelopeVoucherCode(reference);
    if (!voucher) throw new HttpError(400, 'ลิงก์ซองไม่ถูกต้อง กรุณาคัดลอกจากซองทรูอีกครั้ง');
    const normalized = `https://gift.truemoney.com/campaign/?v=${voucher}`;
    const used = await db
      .prepare(
        `SELECT id, user_id, status FROM topups
         WHERE method = 'envelope' AND status IN ('pending', 'approved')
           AND (reference = ? OR reference = ? OR reference LIKE ?)
         LIMIT 1`,
      )
      .bind(reference, normalized, `%v=${voucher}%`)
      .first();
    if (used) {
      throw new HttpError(
        409,
        used.user_id === user.id
          ? 'คุณแจ้งซองนี้ไปแล้ว — ระบบกำลังตรวจสอบยอด ไม่ต้องแจ้งซ้ำ'
          : 'ซองนี้ถูกใช้ในระบบแล้ว ไม่สามารถใช้ซ้ำได้',
      );
    }
  }

  const fee = money((amount * FEE_PERCENT) / 100);
  const net = money(amount - fee);
  const result = await db
    .prepare(
      `INSERT INTO topups (user_id, method, amount, fee, net, reference, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(user.id, method, amount, fee, net, reference, note)
    .run();

  return json(
    {
      ok: true,
      topup: { id: result.meta.last_row_id, method, amount, fee, net, status: 'pending' },
      message: `แจ้งเติมเงิน ฿${amount.toLocaleString('th-TH')} แล้ว รอแอดมินตรวจสอบ — รับจริง ฿${net.toLocaleString('th-TH')} (หัก ${FEE_PERCENT}% = ฿${fee.toLocaleString('th-TH')})`,
    },
    201,
  );
}

async function listMyTopups(ctx) {
  const user = requireUser(ctx);
  const settings = await getSettings(ctx.db);
  const rows = await ctx.db
    .prepare(
      `SELECT id, method, amount, fee, net, reference, status, created_at, review_note
       FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT 60`,
    )
    .bind(user.id)
    .all();
  return json({
    feePercent: FEE_PERCENT,
    payment: {
      ticketPhone: TICKET_PHONE,
      bank: {
        name: settings.bank_name || '',
        account: settings.bank_account || '',
        holder: settings.bank_holder || '',
      },
      note: settings.topup_note || '',
    },
    topups: rows.results.map((t) => ({
      id: t.id,
      method: t.method,
      amount: money(t.amount),
      fee: money(t.fee),
      net: money(t.net),
      reference: t.reference,
      status: t.status,
      note: t.review_note,
      createdAt: t.created_at,
    })),
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
  const result = await purchaseKeys(db, user, productId, quantity);
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
  const body = await readJson(ctx.request, 2048);
  const action = str(body.action, { label: 'การทำรายการ', min: 5, max: 10 });
  if (action !== 'approve' && action !== 'reject') throw new HttpError(400, 'การทำรายการไม่ถูกต้อง');
  const reviewNote = str(body.note, { label: 'หมายเหตุ', max: 200, required: false });

  const topup = await db.prepare('SELECT * FROM topups WHERE id = ?').bind(id).first();
  if (!topup) throw new HttpError(404, 'ไม่พบรายการเติมเงิน');
  if (topup.status !== 'pending') throw new HttpError(409, 'รายการนี้ถูกตรวจสอบไปแล้ว');

  if (action === 'reject') {
    const result = await db
      .prepare(
        `UPDATE topups SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(ctx.user.id, reviewNote, id)
      .run();
    if (Number(result.meta.changes) !== 1) throw new HttpError(409, 'รายการนี้ถูกตรวจสอบไปแล้ว');
    await logStaff(ctx, 'topup.reject', `#${id} ฿${money(topup.amount)}`);
    return json({ ok: true, status: 'rejected' });
  }

  const amount = money(topup.amount);
  const fee = money((amount * FEE_PERCENT) / 100);
  const net = money(amount - fee);

  const result = await db
    .prepare(
      `UPDATE topups SET status = 'approved', fee = ?, net = ?, reviewed_by = ?,
       reviewed_at = datetime('now'), review_note = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(fee, net, ctx.user.id, reviewNote, id)
    .run();
  if (Number(result.meta.changes) !== 1) throw new HttpError(409, 'รายการนี้ถูกตรวจสอบไปแล้ว');

  await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(net, topup.user_id).run();
  const user = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(topup.user_id).first();
  await logStaff(ctx, 'topup.approve', `#${id} รับ ฿${amount} หัก 3% (฿${fee}) เข้า ฿${net}`);

  return json({
    ok: true,
    status: 'approved',
    amount,
    fee,
    net,
    feePercent: FEE_PERCENT,
    balance: money(user?.balance || 0),
    message: `รับเงิน ฿${amount.toLocaleString('th-TH')} — หัก ${FEE_PERCENT}% (฿${fee.toLocaleString('th-TH')}) — เติมเข้าบัญชี ฿${net.toLocaleString('th-TH')}`,
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
  ['POST', /^\/api\/tickets$/, createTicket],
  ['GET', /^\/api\/tickets$/, listMyTickets],
  ['GET', /^\/api\/reseller$/, resellerSummary],
  ['POST', /^\/api\/reseller\/apply$/, resellerApply],
  ['POST', /^\/api\/reseller\/renew$/, resellerRenew],
  ['POST', /^\/api\/reseller\/keys$/, resellerCreateKey],
  ['DELETE', /^\/api\/reseller\/keys\/(\d+)$/, resellerRevokeKey],
  ['GET', /^\/api\/v1\/products$/, apiDealerProducts],
  ['POST', /^\/api\/v1\/purchase$/, apiDealerPurchase],
  ['GET', /^\/api\/admin\/overview$/, adminOverview],
  ['GET', /^\/api\/admin\/products$/, adminListProducts],
  ['POST', /^\/api\/admin\/products$/, adminCreateProduct],
  ['PATCH', /^\/api\/admin\/products\/(\d+)$/, adminUpdateProduct],
  ['DELETE', /^\/api\/admin\/products\/(\d+)$/, adminDeleteProduct],
  ['GET', /^\/api\/admin\/products\/(\d+)\/keys$/, adminListKeys],
  ['POST', /^\/api\/admin\/products\/(\d+)\/keys$/, adminAddKeys],
  ['DELETE', /^\/api\/admin\/products\/(\d+)\/keys\/(\d+)$/, adminDeleteKey],
  ['DELETE', /^\/api\/admin\/products\/(\d+)\/demo-keys$/, adminDeleteDemoKeys],
  ['GET', /^\/api\/admin\/categories$/, adminListCategories],
  ['POST', /^\/api\/admin\/categories$/, adminCreateCategory],
  ['PATCH', /^\/api\/admin\/categories\/(\d+)$/, adminUpdateCategory],
  ['DELETE', /^\/api\/admin\/categories\/(\d+)$/, adminDeleteCategory],
  ['GET', /^\/api\/admin\/topups$/, adminListTopups],
  ['POST', /^\/api\/admin\/topups\/(\d+)\/review$/, adminReviewTopup],
  ['GET', /^\/api\/admin\/coupons$/, adminListCoupons],
  ['POST', /^\/api\/admin\/coupons$/, adminCreateCoupon],
  ['PATCH', /^\/api\/admin\/coupons\/(\d+)$/, adminUpdateCoupon],
  ['DELETE', /^\/api\/admin\/coupons\/(\d+)$/, adminDeleteCoupon],
  ['GET', /^\/api\/admin\/coupons\/(\d+)\/usages$/, adminCouponUsages],
  ['GET', /^\/api\/admin\/users$/, adminListUsers],
  ['PATCH', /^\/api\/admin\/users\/(\d+)\/role$/, adminUpdateRole, requireOwner],
  ['POST', /^\/api\/admin\/settings$/, adminUpdateSettings],
  ['GET', /^\/api\/admin\/tickets$/, adminListTickets],
  ['POST', /^\/api\/admin\/tickets\/(\d+)\/reply$/, adminReplyTicket],
  ['GET', /^\/api\/admin\/logs$/, adminLogs],
  ['GET', /^\/api\/admin\/resellers$/, adminListResellers],
  ['POST', /^\/api\/admin\/resellers\/(\d+)\/review$/, adminReviewReseller],
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
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'",
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

    try {
      await initDb(env);

      // ชั้นป้องกัน DDoS / flood / bot spam — ทุกคำขอ API ต้องผ่านก่อน
      await guardRequest({ db: env.DB, ip: clientIp(request), method: request.method, url: request.url });

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

      const session = await readSession(secret, cookies[SESSION_COOKIE]);
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

      for (const [method, pattern, handler, guard] of routes) {
        if (request.method !== method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        if (url.pathname.startsWith('/api/admin/')) requireStaff(context);
        if (guard) guard(context);
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
