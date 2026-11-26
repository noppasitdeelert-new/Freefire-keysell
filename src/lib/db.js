import { hashPassword, randomHex } from './security.js';
import { ADMIN_ROLES, PERMISSIONS, ROLE_PERMISSIONS } from './perms.js';

export const ROLES = {
  owner: { rank: 1, label: 'Owner (Super Admin)' },
  admin: { rank: 2, label: 'Admin' },
  moderator: { rank: 3, label: 'Moderator' },
  support: { rank: 4, label: 'Support' },
  dealer: { rank: 5, label: 'ตัวแทน/ตัวขาย' },
  member: { rank: 6, label: 'Member' },
};

/** ยศที่ถือเป็นทีมงาน (เห็นหลังบ้าน) */
export const STAFF_ROLES = ['owner', 'admin', 'moderator', 'support'];

export const BRAND = 'VEXIS';
export const BRAND_FULL = 'VEXIS KEY STORE';
export const DEALER_DISCOUNT = 0.35; // ตัวแทนซื้อถูกลง 35%
export const FEE_PERCENT = 3; // หักค่าธรรมเนียม 3%
export const TICKET_PHONE = '0805894742'; // เบอร์รับซองทรู (ล็อกถาวร) — แสดงเฉพาะผู้ที่เข้าสู่ระบบแล้วเท่านั้น ห้ามแสดงสาธารณะ
export const DISCORD_URL = 'https://discord.gg/2ZNazcaDbY'; // ชุมชน Discord อย่างเป็นทางการ
export const RESELLER_FEE = 30; // ค่าบริการตัวแทนรายเดือน
export const RESELLER_WEEKLY_TARGET = 250; // ยอดขายขั้นต่ำต่อสัปดาห์
export const RESELLER_MONTHLY_TARGET = 650; // ยอดขายขั้นต่ำต่อเดือน
export const RESELLER_TRIAL_DAYS = 30; // รอบประเมินตัวแทน (ถ้าไม่ถึงเป้าจะถูกปลด)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    balance REAL NOT NULL DEFAULT 0,
    is_root INTEGER NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    method TEXT NOT NULL,
    amount REAL NOT NULL,
    fee REAL NOT NULL,
    net REAL NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by INTEGER,
    reviewed_at TEXT,
    review_note TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reply TEXT NOT NULL DEFAULT '',
    replied_by INTEGER,
    replied_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS captchas (
    id TEXT PRIMARY KEY,
    answer TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS stock_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    order_id INTEGER,
    sold_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS reseller_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    contact TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    fee_paid_until TEXT,
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_by INTEGER,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT 'API key',
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL DEFAULT '',
    last_used_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS ip_bans (
    ip TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    hits INTEGER NOT NULL DEFAULT 1,
    banned_until INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'percent',
    value REAL NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 0,
    per_user_limit INTEGER NOT NULL DEFAULT 1,
    min_spend REAL NOT NULL DEFAULT 0,
    product_id INTEGER,
    category_id INTEGER,
    starts_at TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS coupon_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    order_id INTEGER,
    code TEXT NOT NULL DEFAULT '',
    discount REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_code ON stock_items (product_id, code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code ON coupons (code)`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_usages_coupon ON coupon_usages (coupon_id)`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_usages_user ON coupon_usages (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stock_items_ready ON stock_items (product_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ip_bans_until ON ip_bans (banned_until)`,
  `CREATE INDEX IF NOT EXISTS idx_reseller_status ON reseller_profiles (status)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`, 
  `CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_topups_user ON topups (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_topups_status ON topups (status)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (user_id)`,

  /* ---------- VEXIS ULTIMATE: ระบบใหม่ (ตารางเพิ่มแบบไม่แตะข้อมูลเดิม) ---------- */
  `CREATE TABLE IF NOT EXISTS referral_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS referral_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'แคมเปญเชิญเพื่อน',
    enabled INTEGER NOT NULL DEFAULT 0,
    signup_reward REAL NOT NULL DEFAULT 0,
    purchase_reward REAL NOT NULL DEFAULT 0,
    reward_type TEXT NOT NULL DEFAULT 'credit',
    max_rewards INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT NOT NULL DEFAULT '',
    ends_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS referral_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referee_id INTEGER NOT NULL,
    campaign_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'signup',
    amount REAL NOT NULL DEFAULT 0,
    reward_type TEXT NOT NULL DEFAULT 'credit',
    status TEXT NOT NULL DEFAULT 'credited',
    ip TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS order_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    actor_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS wishlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS wishlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wishlist_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    price_at_add REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    to_email TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    provider TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS translation_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    locale TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    native_label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS translation_strings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    locale TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS fraud_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    event_type TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'low',
    description TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'open',
    reviewed_by INTEGER,
    reviewed_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS fraud_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    actor_id INTEGER,
    action TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS system_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'minor',
    status TEXT NOT NULL DEFAULT 'investigating',
    body TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS health_check_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS admin_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    rank INTEGER NOT NULL DEFAULT 9,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS admin_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS admin_role_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    role_key TEXT NOT NULL,
    granted_by INTEGER,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS admin_permission_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    permission TEXT NOT NULL,
    allow INTEGER NOT NULL DEFAULT 1,
    granted_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_tx_unique ON referral_transactions (referrer_id, referee_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_referral_tx_referrer ON referral_transactions (referrer_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_items_unique ON wishlist_items (wishlist_id, product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_order_history_order ON order_status_history (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fraud_events_status ON fraud_events (review_status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fraud_events_user ON fraud_events (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_health_logs_service ON health_check_logs (service, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_strings_unique ON translation_strings (locale, key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_perm_unique ON admin_permission_assignments (user_id, permission)`,

  /* ---------- TrueMoney Gift Envelope & Wallet Ledger ---------- */
  `CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    balance_before REAL NOT NULL DEFAULT 0,
    balance_after REAL NOT NULL DEFAULT 0,
    ref_type TEXT NOT NULL DEFAULT '',
    ref_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL UNIQUE,
    actor_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS gift_envelope_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topup_id INTEGER,
    voucher_code TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'none',
    raw_response TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS topup_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topup_id INTEGER NOT NULL,
    actor_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    evidence TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions (user_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_topup_verifications_topup ON topup_verifications (topup_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gift_envelope_status ON gift_envelope_transactions (status)`,
];

const SEED_SETTINGS = [
  ['store_name', BRAND_FULL],
  ['store_tagline', 'คีย์ฟีฟายพรีเมียม ส่งไว 24 ชม. โดย VEXIS'],
  ['bank_name', 'ธนาคารกสิกรไทย'],
  ['bank_account', '080-5-894-742'],
  ['bank_holder', 'ร้าน VEXIS KEY STORE'],
  ['topup_note', 'โอนแล้วแนบสลิป/เลขอ้างอิง ระบบจะหักค่าธรรมเนียม 3% จากยอดที่ได้รับ'],
];

/** สินค้าหลักของแบรนด์ VEXIS — เพิ่มแบบไม่ทับข้อมูลเดิมและไม่แตะสต็อก/ยอดเงิน */
export const DEFAULT_CATALOG = [
  {
    category: 'Phantom',
    name: 'PHANTOM KEY',
    description: 'คีย์ Phantom สำหรับ Free Fire ปลดล็อกฟีเจอร์ครบชุด ส่งคีย์อัตโนมัติทันทีหลังชำระเงิน',
    duration: '30 วัน',
    price: 299,
  },
  {
    category: 'Rezzx mods',
    name: 'REZZX MOD KEY',
    description: 'คีย์ Rezzx Mod อัปเดตไว ใช้งานได้ทั้งมือถือและอีมูเลเตอร์',
    duration: '30 วัน',
    price: 249,
  },
  {
    category: 'Aimhack',
    name: 'AIMHACK KEY',
    description: 'คีย์ Aimhack พร้อมระบบช่วยเล็ง ปรับแต่งค่าได้ละเอียด',
    duration: '30 วัน',
    price: 349,
  },
];

const SEED_PRODUCTS = DEFAULT_CATALOG.map((item) => [
  item.category,
  item.name,
  item.description,
  item.price,
  0,
  item.duration,
]);

let initPromise = null;

/** คีย์ตัวอย่าง DEMO-... ห้ามถูกนับเป็นสต็อกและห้ามถูกส่งขายให้ลูกค้าเด็ดขาด */
export const DEMO_PREFIX = 'DEMO-';

/** ทำให้จำนวนสต็อกของสินค้าตรงกับจำนวนคีย์จริงที่พร้อมขาย */
export async function syncStock(db, productId) {
  await db
    .prepare(
      `UPDATE products SET stock =
         (SELECT COUNT(*) FROM stock_items
          WHERE product_id = ? AND status = 'available' AND code NOT LIKE 'DEMO-%')
       WHERE id = ?`,
    )
    .bind(productId, productId)
    .run();
}

async function seedUltimate(db) {
  // บทบาทแอดมิน + แคตตาล็อกสิทธิ์ (ค่าตั้งต้นตามสเปก)
  for (const [key, meta] of Object.entries(ADMIN_ROLES)) {
    await db
      .prepare('INSERT INTO admin_roles (key, name, rank, permissions) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .bind(key, meta.label, meta.rank, JSON.stringify(ROLE_PERMISSIONS[key] || []))
      .run();
  }
  for (const [key, label] of Object.entries(PERMISSIONS)) {
    await db
      .prepare('INSERT INTO admin_permissions (key, label, group_name) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .bind(key, label, key.split('.')[0])
      .run();
  }

  // แคมเปญเชิญเพื่อนเริ่มต้น: ปิดไว้และรางวัล 0 → แอดมินต้องตั้งเองก่อนจึงจะจ่ายรางวัล
  const campaign = await db.prepare('SELECT id FROM referral_campaigns LIMIT 1').first();
  if (!campaign) {
    await db
      .prepare(
        `INSERT INTO referral_campaigns (name, enabled, signup_reward, purchase_reward, reward_type, max_rewards)
         VALUES ('แคมเปญเชิญเพื่อน VEXIS', 0, 0, 0, 'credit', 0)`,
      )
      .run();
  }

  await db.batch([
    db.prepare(
      "INSERT INTO translation_settings (locale, label, native_label, enabled, is_default) VALUES ('th', 'Thai', 'ไทย', 1, 1) ON CONFLICT(locale) DO NOTHING",
    ),
    db.prepare(
      "INSERT INTO translation_settings (locale, label, native_label, enabled, is_default) VALUES ('en', 'English', 'English', 1, 0) ON CONFLICT(locale) DO NOTHING",
    ),
  ]);
}

async function seed(db) {
  for (const [key, value] of SEED_SETTINGS) {
    await db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .bind(key, value)
      .run();
  }

  const root = await db.prepare('SELECT id FROM users WHERE is_root = 1 LIMIT 1').first();
  if (!root) {
    const salt = randomHex(16);
    const hash = await hashPassword('2235', salt);
    await db
      .prepare(
        `INSERT INTO users (username, password_hash, salt, role, balance, is_root, display_name)
         VALUES ('New', ?, ?, 'owner', 0, 1, 'New (Owner สูงสุด)')
         ON CONFLICT(username) DO NOTHING`,
      )
      .bind(hash, salt)
      .run();
  }

  const categoryCount = await db.prepare('SELECT COUNT(*) AS total FROM categories').first();
  if (Number(categoryCount?.total || 0) === 0) {
    const names = [...new Set(SEED_PRODUCTS.map((p) => p[0]))];
    for (let i = 0; i < names.length; i += 1) {
      await db
        .prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)')
        .bind(names[i], 'หมวดหมู่ ' + names[i], i + 1)
        .run();
    }
    const cats = await db.prepare('SELECT id, name FROM categories').all();
    const byName = new Map(cats.results.map((c) => [c.name, c.id]));
    for (const [cat, name, description, price, stock, duration] of SEED_PRODUCTS) {
      await db
        .prepare(
          'INSERT INTO products (category_id, name, description, price, stock, duration) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(byName.get(cat), name, description, price, stock, duration)
        .run();
    }
  }
}

/** เพิ่มคอลัมน์ใหม่แบบไม่ทำลายข้อมูลเดิม (ใช้กับฐานข้อมูลที่สร้างไว้ก่อนหน้า) */
async function addColumnIfMissing(db, table, column, ddl) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (info.results.some((row) => row.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
}

/**
 * อัปเกรดแบรนด์เป็น VEXIS — เปลี่ยนเฉพาะค่าที่ยังเป็นค่าเริ่มต้นเดิมของร้าน
 * ค่าที่แอดมินแก้เองแล้วจะไม่ถูกแตะ และไม่มีการลบข้อมูลใด ๆ
 */
async function migrateBrand(db) {
  const done = await db.prepare("SELECT value FROM settings WHERE key = 'brand_v2'").first();
  if (done) return;
  await db.batch([
    db
      .prepare("UPDATE settings SET value = ? WHERE key = 'store_name' AND value = 'FIREKEY STORE'")
      .bind(BRAND_FULL),
    db
      .prepare(
        "UPDATE settings SET value = ? WHERE key = 'store_tagline' AND value = 'คีย์ฟีฟายราคาส่ง ส่งไว 24 ชม.'",
      )
      .bind('คีย์ฟีฟายพรีเมียม ส่งไว 24 ชม. โดย VEXIS'),
    db
      .prepare("UPDATE settings SET value = ? WHERE key = 'bank_holder' AND value = 'ร้าน FIREKEY STORE'")
      .bind('ร้าน VEXIS KEY STORE'),
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('brand_v2', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
  ]);
}

/**
 * เปลี่ยนชื่อร้านที่แสดงในระบบเป็น VEXIS ให้ครบทุกจุด (ทำครั้งเดียว)
 * แตะเฉพาะค่า settings ไม่ยุ่งกับคีย์/ยอดเงิน/ประวัติการซื้อ
 */
async function migrateBrandV3(db) {
  const done = await db.prepare("SELECT value FROM settings WHERE key = 'brand_v3'").first();
  if (done) return;
  await db.batch([
    db.prepare("UPDATE settings SET value = ? WHERE key = 'store_name'").bind(BRAND_FULL),
    db
      .prepare("UPDATE settings SET value = ? WHERE key = 'store_tagline' AND value LIKE '%FIREKEY%'")
      .bind('คีย์ฟีฟายพรีเมียม ส่งไว 24 ชม. โดย VEXIS'),
    db
      .prepare("UPDATE settings SET value = ? WHERE key = 'bank_holder' AND value LIKE '%FIREKEY%'")
      .bind('ร้าน VEXIS KEY STORE'),
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('brand_v3', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
  ]);
}

/**
 * เพิ่มสินค้าหลักของแบรนด์ให้ฐานข้อมูลเดิม (ทำครั้งเดียว)
 * - ไม่แก้ราคา/สต็อกของสินค้าที่มีอยู่แล้ว
 * - ไม่ลบหรือรีเซ็ตคีย์/ยอดเงิน/ประวัติใด ๆ
 */
async function migrateCatalog(db) {
  const done = await db.prepare("SELECT value FROM settings WHERE key = 'catalog_v2'").first();
  if (done) return;

  const maxOrder = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS v FROM categories').first();
  let sort = Number(maxOrder?.v || 0);

  for (const item of DEFAULT_CATALOG) {
    let category = await db
      .prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE')
      .bind(item.category)
      .first();
    if (!category) {
      sort += 1;
      const created = await db
        .prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)')
        .bind(item.category, 'หมวดหมู่ ' + item.category, sort)
        .run();
      category = { id: created.meta.last_row_id };
    }

    const exists = await db
      .prepare('SELECT id FROM products WHERE name = ? COLLATE NOCASE')
      .bind(item.name)
      .first();
    if (exists) continue;

    await db
      .prepare(
        'INSERT INTO products (category_id, name, description, price, stock, duration) VALUES (?, ?, ?, ?, 0, ?)',
      )
      .bind(category.id, item.name, item.description, item.price, item.duration)
      .run();
  }

  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('catalog_v2', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run();
}

export function initDb(env) {
  if (!initPromise) {
    const run = async () => {
      const db = env.DB;
      await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
      // รองรับระยะเวลาการใช้งานของสินค้าในฐานข้อมูลเดิม โดยไม่รีเซ็ตข้อมูล
      await addColumnIfMissing(db, 'products', 'duration', "duration TEXT NOT NULL DEFAULT ''");
      // token กันการกดซื้อซ้ำ (ไม่กระทบออเดอร์เดิมเพราะค่าเริ่มต้นเป็นค่าว่าง)
      await addColumnIfMissing(db, 'orders', 'client_token', "client_token TEXT NOT NULL DEFAULT ''");
      // ส่วนลดคูปองที่ใช้กับออเดอร์ (ออเดอร์เดิมได้ค่าเริ่มต้นเป็น 0)
      await addColumnIfMissing(db, 'orders', 'coupon_code', "coupon_code TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(db, 'orders', 'discount', 'discount REAL NOT NULL DEFAULT 0');

      // VEXIS ULTIMATE — คอลัมน์เพิ่มเติมสำหรับระบบใหม่ (ค่าเริ่มต้นไม่กระทบข้อมูลเดิม)
      await addColumnIfMissing(db, 'users', 'email', "email TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(db, 'users', 'email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0');
      await addColumnIfMissing(db, 'users', 'locale', "locale TEXT NOT NULL DEFAULT 'th'");
      await addColumnIfMissing(db, 'users', 'online_at', 'online_at TEXT');
      await addColumnIfMissing(db, 'users', 'referred_by', 'referred_by INTEGER');
      await addColumnIfMissing(db, 'users', 'restricted', 'restricted INTEGER NOT NULL DEFAULT 0');
      await addColumnIfMissing(db, 'users', 'points', 'points INTEGER NOT NULL DEFAULT 0');
      await addColumnIfMissing(db, 'users', 'restriction_reason', "restriction_reason TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(db, 'orders', 'payment_status', "payment_status TEXT NOT NULL DEFAULT 'paid'");
      await addColumnIfMissing(db, 'orders', 'delivery_status', "delivery_status TEXT NOT NULL DEFAULT 'delivered'");
      await addColumnIfMissing(db, 'orders', 'refunded_total', 'refunded_total REAL NOT NULL DEFAULT 0');

      // TrueMoney Gift Envelope — คอลัมน์สำหรับตรวจสอบยอดจริง/กันซ้ำ (ค่าเริ่มต้นไม่กระทบรายการเดิม)
      await addColumnIfMissing(db, 'topups', 'voucher_code', "voucher_code TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(db, 'topups', 'verification_source', "verification_source TEXT NOT NULL DEFAULT 'none'");
      await addColumnIfMissing(db, 'topups', 'idempotency_key', "idempotency_key TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(db, 'topups', 'declared_amount', 'declared_amount REAL NOT NULL DEFAULT 0');
      await addColumnIfMissing(db, 'topups', 'balance_before', 'balance_before REAL NOT NULL DEFAULT 0');
      await addColumnIfMissing(db, 'topups', 'balance_after', 'balance_after REAL NOT NULL DEFAULT 0');
      await db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_topups_voucher ON topups (voucher_code) WHERE voucher_code <> ''",
        )
        .run();
      await db
        .prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_topups_idempotency ON topups (user_id, idempotency_key) WHERE idempotency_key <> ''",
        )
        .run();

      await seed(db);
      await seedUltimate(db);
      await migrateBrand(db);
      await migrateBrandV3(db);
      await migrateCatalog(db);

      // คีย์ตัวอย่าง DEMO- ของเดิม → แยกสถานะ 'demo' เพื่อไม่ให้ถูกนับเป็นสต็อกหรือถูกส่งขาย
      await db
        .prepare("UPDATE stock_items SET status = 'demo' WHERE code LIKE 'DEMO-%' AND status <> 'sold'")
        .run();

      // จำนวนสต็อกที่แสดงต้องตรงกับคีย์จริงที่พร้อมขายเสมอ
      await db
        .prepare(
          `UPDATE products SET stock =
             (SELECT COUNT(*) FROM stock_items
              WHERE product_id = products.id AND status = 'available' AND code NOT LIKE 'DEMO-%')`,
        )
        .run();

      const now = Date.now();
      await db.batch([
        db.prepare('DELETE FROM captchas WHERE expires_at < ?').bind(now - 60 * 60 * 1000),
        db.prepare('DELETE FROM ip_bans WHERE banned_until < ?').bind(now - 7 * 24 * 60 * 60 * 1000),
        db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now - 60 * 60 * 1000),
      ]);
    };
    initPromise = (async () => {
      try {
        await run();
      } catch (first) {
        // D1 สะดุดชั่วคราว (โควตา/คิวพร้อมกัน) ไม่ควรทำให้ทั้งเว็บขึ้นหน้า error
        await new Promise((resolve) => setTimeout(resolve, 250));
        await run();
      }
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export async function audit(db, actor, action, detail) {
  await db
    .prepare('INSERT INTO audit_logs (actor_id, actor_name, action, detail) VALUES (?, ?, ?, ?)')
    .bind(actor ? actor.id : null, actor ? actor.username : 'system', action, String(detail || '').slice(0, 400))
    .run();
}
