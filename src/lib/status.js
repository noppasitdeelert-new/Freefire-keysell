/**
 * System Status — สถานะทั้งหมดมาจาก Health Check จริง
 * ไม่มีค่าที่ "ตั้งเป็นเขียวตลอด" และบริการภายนอกที่ตรวจไม่ได้จะแสดง unknown
 */

export const STATUS = {
  operational: { label: 'Operational', th: 'ทำงานปกติ', level: 1 },
  degraded: { label: 'Degraded Performance', th: 'ทำงานช้าลง', level: 2 },
  partial_outage: { label: 'Partial Outage', th: 'ทำงานบางส่วน', level: 3 },
  major_outage: { label: 'Major Outage', th: 'ล่ม', level: 4 },
  maintenance: { label: 'Maintenance', th: 'ปิดปรับปรุง', level: 5 },
  unknown: { label: 'Unknown', th: 'ตรวจสอบไม่ได้', level: 0 },
};

const SLOW_MS = 800;

async function timed(fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const latency = Date.now() - started;
    return {
      status: latency > SLOW_MS ? 'degraded' : 'operational',
      latency,
      detail: detail || '',
    };
  } catch (error) {
    return {
      status: 'major_outage',
      latency: Date.now() - started,
      detail: String((error && error.message) || error).slice(0, 200),
    };
  }
}

/**
 * ตรวจทุกบริการด้วยคำสั่งจริงกับ D1 / config
 */
export async function runHealthChecks(env) {
  const db = env.DB;
  const checks = [];

  checks.push({
    key: 'website',
    label: 'Website',
    ...(await timed(async () => {
      const res = await env.ASSETS.fetch(new Request('https://internal.local/index.html'));
      if (!res.ok) throw new Error(`assets HTTP ${res.status}`);
      return 'หน้าเว็บหลักโหลดได้';
    })),
  });

  checks.push({
    key: 'database',
    label: 'Database',
    ...(await timed(async () => {
      const row = await db.prepare('SELECT COUNT(*) AS total FROM users').first();
      return `ผู้ใช้ ${Number(row.total)} บัญชี`;
    })),
  });

  const authCheck = await timed(async () => {
    const row = await db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'owner'").first();
    if (Number(row.total) < 1) throw new Error('ไม่พบบัญชี Owner ในระบบ');
    return `ตรวจสอบเซสชันได้ (Owner ${Number(row.total)} บัญชี)`;
  });
  const secret = String(env.SESSION_SECRET || '');
  checks.push({
    key: 'auth',
    label: 'Authentication',
    ...(secret.length < 16 && authCheck.status === 'operational'
      ? {
          ...authCheck,
          status: 'degraded',
          detail: 'ยังไม่ได้ตั้งค่า SESSION_SECRET (ใช้ค่าระบบเริ่มต้น — ไม่ปลอดภัยบน production)',
        }
      : authCheck),
  });

  checks.push({
    key: 'catalog',
    label: 'Product Catalog',
    ...(await timed(async () => {
      const row = await db
        .prepare('SELECT COUNT(*) AS total FROM products WHERE active = 1')
        .first();
      return `สินค้าเปิดขาย ${Number(row.total)} รายการ`;
    })),
  });

  checks.push({
    key: 'checkout',
    label: 'Checkout',
    ...(await timed(async () => {
      const [orders, stock] = await db.batch([
        db.prepare("SELECT COUNT(*) AS total FROM orders WHERE created_at >= datetime('now', '-7 days')"),
        db.prepare("SELECT COUNT(*) AS total FROM stock_items WHERE status = 'available'"),
      ]);
      return `ออเดอร์ 7 วัน ${Number(orders.results[0].total)} · คีย์พร้อมขาย ${Number(stock.results[0].total)}`;
    })),
  });

  checks.push({
    key: 'wallet',
    label: 'Wallet',
    ...(await timed(async () => {
      const row = await db.prepare('SELECT COALESCE(SUM(balance), 0) AS total FROM users').first();
      return `ยอดเครดิตรวม ฿${Number(row.total).toFixed(2)}`;
    })),
  });

  checks.push({
    key: 'key_delivery',
    label: 'Key Delivery',
    ...(await timed(async () => {
      const row = await db
        .prepare(
          "SELECT COUNT(*) AS total FROM order_items WHERE created_at >= datetime('now', '-24 hours')",
        )
        .first();
      return `ส่งคีย์ 24 ชั่วโมง ${Number(row.total)} รายการ`;
    })),
  });

  const emailConfigured = Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM);
  checks.push({
    key: 'notification',
    label: 'Notification',
    status: emailConfigured ? 'operational' : 'unknown',
    latency: 0,
    detail: emailConfigured ? 'ตั้งค่า Email Provider แล้ว' : 'ยังไม่ได้ตั้งค่า EMAIL_API_KEY/EMAIL_FROM — อีเมลไม่ถูกส่ง',
  });

  return checks;
}

/** บันทึกผลตรวจลง health_check_logs (อย่างน้อย 60 วินาทีต่อครั้ง) */
export async function logHealthChecks(db, checks) {
  try {
    const last = await db
      .prepare("SELECT created_at FROM health_check_logs ORDER BY id DESC LIMIT 1")
      .first();
    if (last) {
      const diff = Date.now() - new Date(`${String(last.created_at).replace(' ', 'T')}Z`).getTime();
      if (diff >= 0 && diff < 60_000) return;
    }
    await db.batch(
      checks.map((check) =>
        db
          .prepare('INSERT INTO health_check_logs (service, status, latency_ms, detail) VALUES (?, ?, ?, ?)')
          .bind(check.key, check.status, check.latency, String(check.detail || '').slice(0, 200)),
      ),
    );
  } catch {
    /* การบันทึก log ล้มเหลวไม่ควรทำให้หน้า status พัง */
  }
}

/** สรุปสถานะรวมจากทุกบริการ (แย่ที่สุดชนะ) */
export function overallStatus(checks, maintenance) {
  if (maintenance) return 'maintenance';
  let worst = 'operational';
  for (const check of checks) {
    if (check.status === 'unknown') continue;
    if (STATUS[check.status].level > STATUS[worst].level) worst = check.status;
  }
  return worst;
}

export function activeIncidentSeverity(incidents) {
  let level = 0;
  for (const incident of incidents) {
    if (incident.status === 'resolved') continue;
    const map = { minor: 2, major: 3, critical: 4 };
    level = Math.max(level, map[incident.severity] || 1);
  }
  return level;
}
