/**
 * Referral System — รหัสเชิญเพื่อน + รางวัลจากแคมเปญที่แอดมินตั้งไว้
 * ทุกธุรกรรมบันทึกใน referral_transactions และให้รางวัลได้ครั้งเดียวต่อเงื่อนไข
 */

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeReferralCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

function randomCode(length = 8) {
  let out = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** ดึง/สร้างรหัสเชิญของสมาชิก (สร้างครั้งแรกเมื่อเรียกใช้เท่านั้น) */
export async function ensureReferralCode(db, userId) {
  const existing = await db
    .prepare('SELECT code FROM referral_codes WHERE user_id = ?')
    .bind(userId)
    .first();
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = randomCode(8);
    try {
      await db
        .prepare('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)')
        .bind(userId, code)
        .run();
      return code;
    } catch {
      const again = await db
        .prepare('SELECT code FROM referral_codes WHERE user_id = ?')
        .bind(userId)
        .first();
      if (again) return again.code;
    }
  }
  throw new Error('ไม่สามารถสร้างรหัสเชิญได้ กรุณาลองใหม่');
}

export async function findReferrerByCode(db, rawCode) {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  return db
    .prepare(
      `SELECT rc.code, rc.user_id, u.username
       FROM referral_codes rc JOIN users u ON u.id = rc.user_id
       WHERE rc.code = ?`,
    )
    .bind(code)
    .first();
}

/** แคมเปญที่เปิดอยู่จริง ณ เวลานี้ (ถ้ามีหลายอัน ใช้ที่อัปเดตล่าสุด) */
export async function activeCampaign(db) {
  const row = await db
    .prepare('SELECT * FROM referral_campaigns ORDER BY id DESC LIMIT 1')
    .first();
  if (!row) return null;
  if (Number(row.enabled) !== 1) return null;
  const now = new Date();
  if (row.starts_at) {
    const start = new Date(`${row.starts_at}T00:00:00Z`);
    if (!Number.isNaN(start.getTime()) && now < start) return null;
  }
  if (row.ends_at) {
    const end = new Date(`${row.ends_at}T23:59:59Z`);
    if (!Number.isNaN(end.getTime()) && now > end) return null;
  }
  return row;
}

async function rewardCount(db, campaignId) {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM referral_transactions WHERE campaign_id = ?')
    .bind(campaignId)
    .first();
  return Number(row?.total || 0);
}

async function giveReward(db, { userId, amount, rewardType }) {
  if (!(amount > 0)) return { credited: 0 };
  if (rewardType === 'point') {
    await db.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(Math.round(amount), userId).run();
    return { credited: Math.round(amount), unit: 'point' };
  }
  await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(round2(amount), userId).run();
  return { credited: round2(amount), unit: 'credit' };
}

/**
 * ให้รางวัล "ผู้สมัครใหม่" — เรียกตอนสมัครสมาชิกสำเร็จ
 * คืนค่า null ถ้าไม่มีผู้เชิญ/แคมเปญปิด/ครบโควตา
 */
export async function awardSignupReward(db, { refereeId, refereeUsername, referrerId, code, ip }) {
  if (!referrerId || referrerId === refereeId) return null;
  const campaign = await activeCampaign(db);
  if (!campaign) return null;
  const reward = round2(campaign.signup_reward);
  const limit = Number(campaign.max_rewards || 0);
  if (limit > 0 && (await rewardCount(db, campaign.id)) >= limit) return null;

  try {
    await db
      .prepare(
        `INSERT INTO referral_transactions
           (referrer_id, referee_id, campaign_id, kind, amount, reward_type, status, ip, note)
         VALUES (?, ?, ?, 'signup', ?, ?, 'credited', ?, ?)`,
      )
      .bind(
        referrerId,
        refereeId,
        campaign.id,
        reward,
        campaign.reward_type,
        String(ip || '').slice(0, 60),
        `ผู้สมัครใหม่ ${refereeUsername} ผ่านรหัส ${code}`,
      )
      .run();
  } catch {
    // unique(referrer_id, referee_id, kind) → ให้รางวัลไปแล้ว
    return null;
  }

  const given = await giveReward(db, {
    userId: referrerId,
    amount: reward,
    rewardType: campaign.reward_type,
  });
  return { amount: given.credited, unit: given.unit, campaignId: campaign.id };
}

/**
 * ให้รางวัล "เพื่อนซื้อสินค้าครั้งแรก" — เรียกหลังซื้อสำเร็จ
 * ให้เพียงครั้งเดียวต่อผู้ถูกเชิญหนึ่งคน
 */
export async function awardFirstPurchaseReward(db, { buyerId, buyerUsername, orderId, ip }) {
  const buyer = await db
    .prepare('SELECT id, username, referred_by FROM users WHERE id = ?')
    .bind(buyerId)
    .first();
  if (!buyer || !buyer.referred_by) return null;
  if (buyer.referred_by === buyerId) return null;

  const campaign = await activeCampaign(db);
  if (!campaign) return null;
  const reward = round2(campaign.purchase_reward);
  const limit = Number(campaign.max_rewards || 0);
  if (limit > 0 && (await rewardCount(db, campaign.id)) >= limit) return null;

  try {
    await db
      .prepare(
        `INSERT INTO referral_transactions
           (referrer_id, referee_id, campaign_id, kind, amount, reward_type, status, ip, note)
         VALUES (?, ?, ?, 'purchase', ?, ?, 'credited', ?, ?)`,
      )
      .bind(
        buyer.referred_by,
        buyerId,
        campaign.id,
        reward,
        campaign.reward_type,
        String(ip || '').slice(0, 60),
        `เพื่อน ${buyerUsername} ซื้อครั้งแรก (ออเดอร์ #${orderId})`,
      )
      .run();
  } catch {
    return null;
  }

  const given = await giveReward(db, {
    userId: buyer.referred_by,
    amount: reward,
    rewardType: campaign.reward_type,
  });
  return { amount: given.credited, unit: given.unit, campaignId: campaign.id };
}

export async function referralStats(db, userId) {
  const [signups, buyers, earned, recent] = await db.batch([
    db
      .prepare("SELECT COUNT(*) AS total FROM referral_transactions WHERE referrer_id = ? AND kind = 'signup'")
      .bind(userId),
    db
      .prepare("SELECT COUNT(*) AS total FROM users WHERE referred_by = ?").bind(userId),
    db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM referral_transactions WHERE referrer_id = ? AND status = 'credited'",
      )
      .bind(userId),
    db
      .prepare(
        `SELECT rt.id, rt.kind, rt.amount, rt.reward_type, rt.status, rt.note, rt.created_at, u.username
         FROM referral_transactions rt LEFT JOIN users u ON u.id = rt.referee_id
         WHERE rt.referrer_id = ? ORDER BY rt.id DESC LIMIT 30`,
      )
      .bind(userId),
  ]);
  return {
    signups: Number(signups.results[0]?.total || 0),
    friends: Number(buyers.results[0]?.total || 0),
    earned: round2(earned.results[0]?.total || 0),
    history: recent.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: round2(row.amount),
      rewardType: row.reward_type,
      status: row.status,
      note: row.note,
      username: row.username || '',
      createdAt: row.created_at,
    })),
  };
}
