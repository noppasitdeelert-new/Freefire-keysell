/**
 * Fraud Detection — บันทึกเหตุการณ์ผิดปกติพร้อมหลักฐาน (ตรวจจากฝั่งเซิร์ฟเวอร์เท่านั้น)
 * หลักการ: ไม่ตัดสินจาก IP อย่างเดียว, ต้องมีหลักฐานประกอบ, กันแจ้งซ้ำถี่เกินไป
 */

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

const RISK_WEIGHT = { low: 1, medium: 2, high: 3, critical: 4 };

/** สรุปหลักฐานเป็นข้อความสั้น ๆ ที่ตรวจย้อนหลังได้ */
function evidenceText(evidence) {
  if (!evidence) return '';
  try {
    return JSON.stringify(evidence).slice(0, 900);
  } catch {
    return String(evidence).slice(0, 900);
  }
}

/**
 * บันทึกเหตุการณ์ผิดปกติ
 * - ถ้ามีเหตุการณ์ชนิดเดียวกันของผู้ใช้คนเดิมภายใน 5 นาที จะไม่บันทึกซ้ำ (กัน noise)
 */
export async function recordFraud(db, { userId = null, type, risk = 'medium', description = '', evidence = null, ip = '' }) {
  const level = RISK_LEVELS.includes(risk) ? risk : 'medium';
  try {
    if (userId) {
      const recent = await db
        .prepare(
          `SELECT id FROM fraud_events
           WHERE user_id = ? AND event_type = ? AND created_at >= datetime('now', '-5 minutes')
           LIMIT 1`,
        )
        .bind(userId, type)
        .first();
      if (recent) return null;
    }
    const inserted = await db
      .prepare(
        `INSERT INTO fraud_events (user_id, event_type, risk, description, evidence, ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, String(type).slice(0, 60), level, String(description).slice(0, 400), evidenceText(evidence), String(ip || '').slice(0, 60))
      .run();
    return inserted.meta.last_row_id;
  } catch {
    // การบันทึกเหตุผิดปกติต้องไม่ทำให้คำขอหลักล้มเหลว
    return null;
  }
}

/** นับเหตุการณ์ความรุนแรงระดับต่าง ๆ ในช่วงเวลาที่กำหนด */
export async function fraudSummary(db) {
  const rows = await db.batch([
    db.prepare('SELECT risk, COUNT(*) AS total FROM fraud_events WHERE review_status = ? GROUP BY risk').bind('open'),
    db.prepare("SELECT COUNT(*) AS total FROM fraud_events WHERE created_at >= datetime('now', '-1 day')"),
    db.prepare('SELECT COUNT(*) AS total FROM users WHERE restricted = 1'),
  ]);
  const byRisk = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const row of rows[0].results) byRisk[row.risk] = Number(row.total);
  return {
    open: byRisk,
    openTotal: Object.values(byRisk).reduce((a, b) => a + b, 0),
    last24h: Number(rows[1].results[0]?.total || 0),
    restrictedUsers: Number(rows[2].results[0]?.total || 0),
  };
}

export function riskRank(risk) {
  return RISK_WEIGHT[risk] || 0;
}

/** เพิ่มระดับความเสี่ยงเมื่อมีหลักฐานหลายอย่างประกอบกัน */
export function escalate(base, count) {
  const start = RISK_LEVELS.indexOf(base);
  const next = Math.min(RISK_LEVELS.length - 1, start + Math.max(0, count - 1));
  return RISK_LEVELS[next];
}

export const FRAUD_LABELS = {
  signup_velocity: 'สมัครสมาชิกจำนวนมากผิดปกติ',
  referral_self: 'พยายามใช้ Referral Code ของตัวเอง',
  referral_same_ip: 'ผู้ถูกเชิญใช้ IP เดียวกับผู้เชิญ',
  referral_duplicate: 'พยายามรับรางวัลเชิญเพื่อนซ้ำ',
  coupon_abuse: 'ใช้คูปองผิดปกติ',
  rapid_purchase: 'ซื้อสินค้าซ้ำอย่างรวดเร็ว',
  api_flood: 'เรียก API ถี่ผิดปกติ',
  wallet_mismatch: 'พยายามเปลี่ยนแปลงยอด Wallet ไม่ถูกต้อง',
  login_failures: 'เข้าสู่ระบบผิดพลาดซ้ำหลายครั้ง',
  admin_unauthorized: 'พยายามเข้าถึง Admin API โดยไม่มีสิทธิ์',
};
