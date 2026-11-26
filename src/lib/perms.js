import { HttpError } from './security.js';

/**
 * Role-Based Access Control (RBAC) ของ VEXIS
 * ------------------------------------------------------------------
 * - สิทธิ์จริงถูกตัดสินจากฐานข้อมูลฝั่งเซิร์ฟเวอร์เท่านั้น
 * - Frontend ใช้เฉพาะเพื่อซ่อน/แสดงปุ่ม ไม่ใช่แหล่งยืนยันสิทธิ์
 * - Super Admin (owner) ได้ทุกสิทธิ์เสมอ
 */

export const ADMIN_ROLES = {
  superadmin: { label: 'Super Admin', rank: 1 },
  admin: { label: 'Admin', rank: 2 },
  moderator: { label: 'Moderator', rank: 3 },
  support: { label: 'Support', rank: 4 },
};

export const PERMISSIONS = {
  'catalog.manage': 'จัดการสินค้าและหมวดหมู่',
  'keys.manage': 'จัดการคลังคีย์',
  'orders.manage': 'จัดการคำสั่งซื้อ',
  'users.view': 'ดูข้อมูลสมาชิก',
  'users.manage': 'จัดการบัญชี/ยศสมาชิก',
  'wallet.manage': 'เติม/หักเครดิตและอนุมัติการเติมเงิน',
  'coupons.manage': 'จัดการคูปอง',
  'refunds.manage': 'จัดการการคืนเงิน',
  'tickets.view': 'ดู Ticket',
  'tickets.reply': 'ตอบกลับ Ticket',
  'reviews.manage': 'ดูแลรีวิว',
  'announcements.manage': 'จัดการประกาศ',
  'reseller.manage': 'จัดการตัวแทน/API',
  'referral.manage': 'จัดการแคมเปญเชิญเพื่อน',
  'analytics.view': 'ดู Analytics',
  'fraud.view': 'ดูเหตุการณ์ผิดปกติ',
  'fraud.act': 'ระงับ/ปลดระงับบัญชีจากเหตุผิดปกติ',
  'status.manage': 'จัดการสถานะระบบและ Maintenance',
  'email.manage': 'จัดการอีเมลแจ้งเตือน',
  'roles.manage': 'จัดการ Admin และสิทธิ์',
  'settings.manage': 'จัดการตั้งค่าร้าน',
  'audit.view': 'ดู Audit Log',
  'backup.manage': 'สำรอง/กู้คืนข้อมูล',
};

export const ROLE_PERMISSIONS = {
  superadmin: Object.keys(PERMISSIONS),
  admin: [
    'catalog.manage',
    'keys.manage',
    'orders.manage',
    'users.view',
    'coupons.manage',
    'reseller.manage',
    'referral.manage',
    'analytics.view',
    'fraud.view',
    'announcements.manage',
    'tickets.view',
    'tickets.reply',
  ],
  moderator: [
    'users.view',
    'tickets.view',
    'tickets.reply',
    'reviews.manage',
    'announcements.manage',
    'fraud.view',
    'analytics.view',
  ],
  support: ['users.view', 'tickets.view', 'tickets.reply', 'orders.manage'],
};

/** ยศใน users.role → บทบาทแอดมิน */
const LEGACY_ROLE_MAP = {
  owner: 'superadmin',
  admin: 'admin',
  moderator: 'moderator',
  support: 'support',
};

export async function permissionsFor(db, user) {
  if (!user) return new Set();
  if (!LEGACY_ROLE_MAP[user.role]) return new Set();
  if (user.role === 'owner') return new Set(Object.keys(PERMISSIONS));

  let roleKey = LEGACY_ROLE_MAP[user.role];
  try {
    const assigned = await db
      .prepare('SELECT role_key FROM admin_role_assignments WHERE user_id = ? AND revoked_at IS NULL')
      .bind(user.id)
      .first();
    if (assigned && ADMIN_ROLES[assigned.role_key]) roleKey = assigned.role_key;
  } catch {
    /* ตารางยังไม่พร้อม → ใช้ค่าจากยศเดิม */
  }

  const set = new Set(ROLE_PERMISSIONS[roleKey] || []);
  try {
    const rows = await db
      .prepare('SELECT permission, allow FROM admin_permission_assignments WHERE user_id = ?')
      .bind(user.id)
      .all();
    for (const row of rows.results) {
      if (Number(row.allow) === 1) set.add(row.permission);
      else set.delete(row.permission);
    }
  } catch {
    /* ไม่มีตาราง override → ใช้สิทธิ์ตามบทบาท */
  }
  return set;
}

export async function permissionList(ctx) {
  if (!ctx.perms) ctx.perms = await permissionsFor(ctx.db || ctx.env.DB, ctx.user);
  return ctx.perms;
}

export async function requirePermission(ctx, permission) {
  if (!ctx.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบก่อนทำรายการ');
  const perms = await permissionList(ctx);
  if (ctx.user.role === 'owner') return ctx.user;
  if (!perms.has(permission)) {
    throw new HttpError(403, `คุณไม่มีสิทธิ์ทำรายการนี้ (${PERMISSIONS[permission] || permission})`);
  }
  return ctx.user;
}

export function isStaffRole(role) {
  return Boolean(LEGACY_ROLE_MAP[role]);
}
