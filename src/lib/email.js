/**
 * Email Notification — ส่งผ่าน provider จริงเท่านั้น
 * ------------------------------------------------------------------
 * - API key เก็บใน Secret ของ Worker (env.EMAIL_API_KEY) ห้ามส่งไป frontend
 * - ถ้ายังไม่ตั้งค่า ระบบจะบันทึกสถานะ 'not_configured' และไม่แกล้งว่าส่งสำเร็จ
 * - รองรับ Resend (ค่าเริ่มต้น) และ generic webhook
 */

export const EMAIL_EVENTS = {
  signup: 'สมัครสมาชิกสำเร็จ',
  verify_email: 'ยืนยันอีเมล',
  order_paid: 'สั่งซื้อสำเร็จ',
  key_delivered: 'ส่งมอบคีย์สำเร็จ',
  topup_approved: 'เติมเงินสำเร็จ',
  refund_done: 'คืนเงินสำเร็จ',
  password_changed: 'เปลี่ยนรหัสผ่าน',
  suspicious_login: 'เข้าสู่ระบบที่น่าสงสัย',
  ticket_reply: 'มีข้อความตอบกลับ Ticket',
  announcement: 'ประกาศสำคัญจากร้าน',
};

export const DEFAULT_SUBJECTS = {
  signup: 'ยินดีต้อนรับสู่ VEXIS',
  verify_email: 'ยืนยันอีเมลของคุณ — VEXIS',
  order_paid: 'คำสั่งซื้อของคุณสำเร็จ — VEXIS',
  key_delivered: 'คีย์ของคุณพร้อมใช้งานแล้ว — VEXIS',
  topup_approved: 'เติมเงินเข้าเครดิตแล้ว — VEXIS',
  refund_done: 'การคืนเงินของคุณเสร็จสิ้น — VEXIS',
  password_changed: 'รหัสผ่านของคุณถูกเปลี่ยน — VEXIS',
  suspicious_login: 'ตรวจพบการเข้าสู่ระบบที่น่าสงสัย — VEXIS',
  ticket_reply: 'ทีมซัพพอร์ตตอบกลับแล้ว — VEXIS',
  announcement: 'ประกาศจากร้าน VEXIS',
};

export const DEFAULT_TEMPLATES = {
  signup: '<p>สวัสดี {{username}}</p><p>บัญชี VEXIS ของคุณถูกสร้างเรียบร้อยแล้ว</p>',
  verify_email: '<p>กรุณายืนยันอีเมลของคุณ: <a href="{{link}}">{{link}}</a></p>',
  order_paid: '<p>คำสั่งซื้อ #{{orderId}} ยอด {{total}} สำเร็จแล้ว</p>',
  key_delivered: '<p>คำสั่งซื้อ #{{orderId}} ส่งคีย์แล้ว:</p><pre>{{codes}}</pre>',
  topup_approved: '<p>เติมเงิน {{amount}} เข้าเครดิตแล้ว (สุทธิ {{net}})</p>',
  refund_done: '<p>คืนเงิน {{amount}} สำหรับคำสั่งซื้อ #{{orderId}} เรียบร้อย</p>',
  password_changed: '<p>รหัสผ่านบัญชี VEXIS ของคุณถูกเปลี่ยนเมื่อ {{time}}</p>',
  suspicious_login: '<p>ตรวจพบการเข้าสู่ระบบจากอุปกรณ์/IP ใหม่: {{ip}}</p>',
  ticket_reply: '<p>Ticket #{{ticketId}} มีข้อความตอบกลับใหม่</p>',
  announcement: '<p>{{body}}</p>',
};

export function emailConfig(env) {
  const provider = String(env.EMAIL_PROVIDER || (env.EMAIL_API_KEY ? 'resend' : '')).toLowerCase();
  const from = String(env.EMAIL_FROM || '').trim();
  const key = String(env.EMAIL_API_KEY || '').trim();
  const configured = Boolean(key && from && (provider === 'resend' || provider === 'webhook'));
  return {
    configured,
    provider: provider || '',
    from,
    reason: configured
      ? ''
      : !key
        ? 'ยังไม่ได้ตั้งค่า EMAIL_API_KEY'
        : !from
          ? 'ยังไม่ได้ตั้งค่า EMAIL_FROM'
          : `provider "${provider}" ไม่รองรับ`,
  };
}

export function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

async function deliver(env, config, { to, subject, html }) {
  if (config.provider === 'webhook') {
    const res = await fetch(String(env.EMAIL_WEBHOOK_URL || ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.EMAIL_API_KEY}` },
      body: JSON.stringify({ to, subject, html, from: config.from }),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
    return { providerId: '' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.EMAIL_API_KEY}` },
    body: JSON.stringify({ from: config.from, to: [to], subject, html }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`resend HTTP ${res.status} ${payload && payload.message ? payload.message : ''}`.trim());
  return { providerId: (payload && payload.id) || '' };
}

/**
 * ส่งอีเมล + บันทึกประวัติทุกครั้ง (สำเร็จ/ล้มเหลว/ยังไม่ตั้งค่า)
 * กันการส่งซ้ำชนิดเดียวกันภายใน 60 วินาที
 */
export async function sendEmail(env, db, { userId = null, to, event, subject, html, template, vars = {} }) {
  const target = String(to || '').trim();
  const label = EMAIL_EVENTS[event] ? event : 'announcement';
  const config = emailConfig(env);

  const record = async (status, extra = {}) => {
    try {
      await db
        .prepare(
          `INSERT INTO email_logs (user_id, to_email, event, subject, status, provider, provider_id, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          target.slice(0, 120),
          label,
          String(subject || '').slice(0, 160),
          status,
          config.provider,
          String(extra.providerId || '').slice(0, 120),
          String(extra.error || '').slice(0, 300),
        )
        .run();
    } catch {
      /* ประวัติส่งอีเมลล้มเหลวไม่ควรทำให้คำขอหลักล้ม */
    }
  };

  if (!target || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
    await record('skipped', { error: 'ไม่มีอีเมลปลายทางที่ถูกต้อง' });
    return { ok: false, reason: 'invalid_address' };
  }

  // แอดมินปิดประเภทอีเมลนี้ไว้ → ไม่ส่ง
  if (db) {
    try {
      const toggle = await db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .bind(`email_event_${label}`)
        .first();
      if (toggle && String(toggle.value) === '0') {
        await record('disabled');
        return { ok: false, reason: 'disabled' };
      }
    } catch {
      /* ไม่มีตาราง settings ก็ส่งต่อ */
    }
  }

  if (!config.configured) {
    await record('not_configured', { error: config.reason });
    return { ok: false, reason: 'not_configured', detail: config.reason };
  }

  const finalHtml = template ? renderTemplate(template, vars) : String(html || '');

  if (db) {
    try {
      const dup = await db
        .prepare(
          `SELECT id FROM email_logs
           WHERE event = ? AND to_email = ? AND status = 'sent'
             AND created_at >= datetime('now', '-60 seconds') LIMIT 1`,
        )
        .bind(label, target)
        .first();
      if (dup) return { ok: false, reason: 'duplicate' };
    } catch {
      /* ไม่มีตาราง log → ส่งต่อ */
    }
  }

  try {
    const result = await deliver(env, config, {
      to: target,
      subject: subject || DEFAULT_SUBJECTS[label],
      html: finalHtml,
    });
    await record('sent', result);
    return { ok: true };
  } catch (error) {
    await record('failed', { error: String(error && error.message ? error.message : error) });
    return { ok: false, reason: 'failed', detail: String(error && error.message ? error.message : error).slice(0, 200) };
  }
}
