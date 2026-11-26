/**
 * VEXIS ULTIMATE — ระบบส่วนขยาย 9 ชุด
 * Referral · Order Tracking · Analytics · Wishlist · Email · i18n · Fraud · System Status · Admin Roles
 *
 * ทุกข้อมูลอ่าน/เขียนจาก D1 จริง ไม่มีข้อมูลจำลอง
 */

import { requirePermission, permissionsFor, ADMIN_ROLES, PERMISSIONS, ROLE_PERMISSIONS } from './lib/perms.js';
import {
  ensureReferralCode,
  referralStats,
  activeCampaign,
  normalizeReferralCode,
  findReferrerByCode,
} from './lib/referral.js';
import { sendEmail, emailConfig, EMAIL_EVENTS, DEFAULT_SUBJECTS, DEFAULT_TEMPLATES } from './lib/email.js';
import { recordFraud, fraudSummary, FRAUD_LABELS } from './lib/fraud.js';
import { runHealthChecks, logHealthChecks, overallStatus, STATUS } from './lib/status.js';

const TIMELINE_STEPS = [
  ['created', 'Order Created', 'สร้างคำสั่งซื้อ'],
  ['paid', 'Payment Verified', 'ตรวจสอบการชำระเงิน'],
  ['processing', 'Processing', 'กำลังดำเนินการ'],
  ['key_assigned', 'Key Assigned', 'มอบคีย์ให้คำสั่งซื้อ'],
  ['delivered', 'Delivery Completed', 'ส่งมอบสำเร็จ'],
];

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvResponse(rows) {
  const body = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="vexis-analytics.csv"',
      'cache-control': 'no-store',
    },
  });
}

function parseRange(url, fallbackDays = 30) {
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || fallbackDays) || fallbackDays));
  const from = String(url.searchParams.get('from') || '').trim();
  const to = String(url.searchParams.get('to') || '').trim();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (from && to) {
    return { from, to, days: null };
  }
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { from: iso(start), to: iso(end), days };
}

function previousRange({ from, to }) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const length = Math.round((end - start) / 86400000) + 1;
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (length - 1) * 86400000);
  return { from: prevStart.toISOString().slice(0, 10), to: prevEnd.toISOString().slice(0, 10) };
}

export function createUltimate(h) {
  const { HttpError, json, readJson, str, num, money, requireUser, logStaff, roleRank, clientIp } = h;

  /* ---------------- shared ---------------- */

  const staffGuard = (ctx) => {
    const user = requireUser(ctx);
    if (!['owner', 'admin', 'moderator', 'support'].includes(user.role)) {
      throw new HttpError(403, 'เฉพาะทีมงานเท่านั้น');
    }
    return user;
  };

  async function ensureWishlist(db, userId) {
    const row = await db.prepare('SELECT id FROM wishlists WHERE user_id = ?').bind(userId).first();
    if (row) return row.id;
    const created = await db.prepare('INSERT INTO wishlists (user_id) VALUES (?)').bind(userId).run();
    return created.meta.last_row_id;
  }

  function orderView(row) {
    return {
      id: row.id,
      username: row.username || '',
      userId: row.user_id,
      productId: row.product_id,
      productName: row.product_name,
      quantity: Number(row.quantity),
      unitPrice: money(row.unit_price),
      subtotal: money(Number(row.unit_price) * Number(row.quantity)),
      discount: money(row.discount),
      total: money(row.total),
      couponCode: row.coupon_code || '',
      status: row.status,
      paymentStatus: row.payment_status || 'paid',
      deliveryStatus: row.delivery_status || 'delivered',
      refunded: money(row.refunded_total || 0),
      createdAt: row.created_at,
    };
  }

  async function timelineFor(db, orderId) {
    const order = await db
      .prepare(
        `SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
      )
      .bind(orderId)
      .first();
    if (!order) throw new HttpError(404, 'ไม่พบคำสั่งซื้อนี้');

    const history = await db
      .prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id ASC')
      .bind(orderId)
      .all();

    const seen = new Map();
    for (const row of history.results) seen.set(row.status, row);

    const codes = await db
      .prepare('SELECT code FROM order_items WHERE order_id = ? ORDER BY id ASC')
      .bind(orderId)
      .all();

    // ถ้ายังไม่มีบันทึกประวัติ (ออเดอร์จากระบบเดิม) ให้สร้างจากเวลาจริงของออเดอร์
    if (seen.size === 0) {
      const created = order.created_at;
      const fallback = [
        ['created', created, 'ระบบสร้างคำสั่งซื้อ'],
        ['paid', created, 'ชำระด้วยเครดิตในกระเป๋า'],
        ['processing', created, 'ระบบจองคีย์อัตโนมัติ'],
        ['key_assigned', created, 'มอบคีย์จากคลัง'],
        ['delivered', created, 'ส่งมอบคีย์ให้สมาชิก'],
      ];
      for (const [status, at, note] of fallback) {
        seen.set(status, { status, created_at: at, note, actor_name: 'system' });
      }
    }

    const steps = TIMELINE_STEPS.map(([key, en, th]) => {
      const row = seen.get(key);
      return {
        key,
        title: en,
        label: th,
        done: Boolean(row),
        at: row ? row.created_at : null,
        note: row ? row.note || '' : '',
        actor: row ? row.actor_name || '' : '',
      };
    });

    return {
      order: orderView(order),
      codes: codes.results.map((row) => row.code),
      steps,
      history: history.results.map((row) => ({
        status: row.status,
        note: row.note,
        actor: row.actor_name,
        at: row.created_at,
      })),
    };
  }

  async function addOrderHistory(db, { orderId, status, note = '', actorId = null, actorName = 'system' }) {
    await db
      .prepare(
        'INSERT INTO order_status_history (order_id, status, note, actor_id, actor_name) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(orderId, status, String(note).slice(0, 200), actorId, String(actorName).slice(0, 60))
      .run();
  }

  /* ================================================================ */
  /* 1) REFERRAL — member                                             */
  /* ================================================================ */

  async function myReferral(ctx) {
    const user = requireUser(ctx);
    const db = ctx.env.DB;
    const code = await ensureReferralCode(db, user.id);
    const stats = await referralStats(db, user.id);
    const campaign = await activeCampaign(db);
    const campaignRow = await db.prepare('SELECT * FROM referral_campaigns ORDER BY id DESC LIMIT 1').first();
    const origin = ctx.url.origin;
    return json({
      code,
      link: `${origin}/#/register?ref=${code}`,
      stats,
      campaign: campaign
        ? {
            id: campaign.id,
            name: campaign.name,
            signupReward: money(campaign.signup_reward),
            purchaseReward: money(campaign.purchase_reward),
            rewardType: campaign.reward_type,
            maxRewards: Number(campaign.max_rewards || 0),
            startsAt: campaign.starts_at,
            endsAt: campaign.ends_at,
            active: true,
          }
        : {
            active: false,
            name: campaignRow ? campaignRow.name : '',
            reason: campaignRow && Number(campaignRow.enabled) === 1 ? 'แคมเปญอยู่นอกช่วงเวลา' : 'แคมเปญถูกปิดอยู่',
          },
    });
  }

  /* ================================================================ */
  /* 2) ORDER TRACKING                                                */
  /* ================================================================ */

  async function myOrderTimeline(ctx, id) {
    const user = requireUser(ctx);
    const db = ctx.env.DB;
    const orderId = Number(id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
    if (!order) throw new HttpError(404, 'ไม่พบคำสั่งซื้อนี้');
    const isOwner = order.user_id === user.id;
    const isStaff = ['owner', 'admin', 'moderator', 'support'].includes(user.role);
    if (!isOwner && !isStaff) throw new HttpError(403, 'คุณไม่มีสิทธิ์ดูคำสั่งซื้อนี้');
    return json(await timelineFor(db, orderId));
  }

  async function adminListOrders(ctx) {
    await requirePermission(ctx, 'orders.manage');
    const db = ctx.env.DB;
    const url = ctx.url;
    const q = String(url.searchParams.get('q') || '').trim();
    const status = String(url.searchParams.get('status') || '').trim();
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50) || 50));

    const where = [];
    const binds = [];
    if (q) {
      where.push('(CAST(o.id AS TEXT) = ? OR u.username LIKE ? OR o.product_name LIKE ?)');
      binds.push(q, `%${q}%`, `%${q}%`);
    }
    if (status) {
      where.push('o.status = ?');
      binds.push(status);
    }
    const rows = await db
      .prepare(
        `SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY o.id DESC LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    const statuses = await db.prepare('SELECT status, COUNT(*) AS total FROM orders GROUP BY status').all();
    return json({
      orders: rows.results.map(orderView),
      statusSummary: statuses.results.map((row) => ({ status: row.status, total: Number(row.total) })),
    });
  }

  async function adminOrderDetail(ctx, id) {
    await requirePermission(ctx, 'orders.manage');
    return json(await timelineFor(ctx.env.DB, Number(id)));
  }

  async function adminOrderStatus(ctx, id) {
    const user = await requirePermission(ctx, 'orders.manage');
    const db = ctx.env.DB;
    const orderId = Number(id);
    const body = await readJson(ctx.request, 1024);
    const order = await db.prepare('SELECT id FROM orders WHERE id = ?').bind(orderId).first();
    if (!order) throw new HttpError(404, 'ไม่พบคำสั่งซื้อนี้');
    const status = str(body.status, { label: 'สถานะ', min: 3, max: 20 });
    const allowed = TIMELINE_STEPS.map((step) => step[0]).concat(['refunded']);
    if (!allowed.includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
    const note = str(body.note, { label: 'หมายเหตุ', max: 200, required: false });
    await addOrderHistory(db, { orderId, status, note, actorId: user.id, actorName: user.username });
    if (status === 'refunded') {
      await db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").bind(orderId).run();
    }
    await logStaff(ctx, 'order.status', `#${orderId} → ${status} ${note}`.trim());
    return json({ ok: true, ...(await timelineFor(db, orderId)) });
  }

  /* ================================================================ */
  /* 3) ANALYTICS                                                     */
  /* ================================================================ */

  async function analyticsData(ctx) {
    const db = ctx.env.DB;
    const url = ctx.url;
    const range = parseRange(url, 30);
    const prev = previousRange(range);
    const productId = Number(url.searchParams.get('productId') || 0) || 0;
    const categoryId = Number(url.searchParams.get('categoryId') || 0) || 0;

    const orderFilter = (from, to) => {
      const parts = ['date(o.created_at) BETWEEN ? AND ?'];
      const binds = [from, to];
      if (productId) {
        parts.push('o.product_id = ?');
        binds.push(productId);
      }
      if (categoryId) {
        parts.push('p.category_id = ?');
        binds.push(categoryId);
      }
      return { sql: parts.join(' AND '), binds };
    };

    const cur = orderFilter(range.from, range.to);
    const pre = orderFilter(prev.from, prev.to);

    const [
      totals,
      prevTotals,
      series,
      members,
      prevMembers,
      products,
      categories,
      keys,
      refunds,
      coupons,
      topMembers,
      frequent,
      inactive,
      repeat,
      activeMembers,
      onlineMembers,
    ] = await db.batch([
      db
        .prepare(
          `SELECT COALESCE(SUM(o.total),0) AS revenue, COUNT(*) AS orders, COUNT(DISTINCT o.user_id) AS buyers
           FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE ${cur.sql}`,
        )
        .bind(...cur.binds),
      db
        .prepare(
          `SELECT COALESCE(SUM(o.total),0) AS revenue, COUNT(*) AS orders
           FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE ${pre.sql}`,
        )
        .bind(...pre.binds),
      db
        .prepare(
          `SELECT date(o.created_at) AS day, COALESCE(SUM(o.total),0) AS revenue, COUNT(*) AS orders
           FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE ${cur.sql}
           GROUP BY day ORDER BY day ASC`,
        )
        .bind(...cur.binds),
      db
        .prepare('SELECT COUNT(*) AS total FROM users WHERE date(created_at) BETWEEN ? AND ?')
        .bind(range.from, range.to),
      db
        .prepare('SELECT COUNT(*) AS total FROM users WHERE date(created_at) BETWEEN ? AND ?')
        .bind(prev.from, prev.to),
      db
        .prepare(
          `SELECT p.id, p.name, p.stock, c.name AS category,
             COALESCE(SUM(oi.id IS NOT NULL), 0) AS sold,
             COALESCE(SUM(o.total), 0) AS revenue
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN order_items oi ON oi.product_id = p.id AND date(oi.created_at) BETWEEN ? AND ?
           LEFT JOIN orders o ON o.id = oi.order_id AND date(o.created_at) BETWEEN ? AND ?
           ${productId ? 'WHERE p.id = ?' : ''}
           GROUP BY p.id ORDER BY sold DESC`,
        )
        .bind(range.from, range.to, range.from, range.to, ...(productId ? [productId] : [])),
      db
        .prepare(
          `SELECT c.id, c.name, COALESCE(SUM(o.total),0) AS revenue, COUNT(o.id) AS orders
           FROM categories c
           LEFT JOIN products p ON p.category_id = c.id
           LEFT JOIN orders o ON o.product_id = p.id AND date(o.created_at) BETWEEN ? AND ?
           ${categoryId ? 'WHERE c.id = ?' : ''}
           GROUP BY c.id ORDER BY revenue DESC`,
        )
        .bind(range.from, range.to, ...(categoryId ? [categoryId] : [])),
      db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM stock_items) AS total_keys,
           (SELECT COUNT(*) FROM stock_items WHERE status = 'sold') AS sold_keys,
           (SELECT COUNT(*) FROM stock_items WHERE status = 'available') AS available_keys`,
      ),
      db
        .prepare(
          `SELECT COALESCE(SUM(o.refunded_total),0) AS refunded, COUNT(CASE WHEN o.refunded_total > 0 THEN 1 END) AS refund_orders
           FROM orders o WHERE date(o.created_at) BETWEEN ? AND ?`,
        )
        .bind(range.from, range.to),
      db
        .prepare(
          `SELECT COUNT(*) AS uses, COALESCE(SUM(cu.discount),0) AS discount
           FROM coupon_usages cu WHERE date(cu.created_at) BETWEEN ? AND ?`,
        )
        .bind(range.from, range.to),
      db
        .prepare(
          `SELECT u.id, u.username, COALESCE(SUM(o.total),0) AS spent, COUNT(o.id) AS orders
           FROM users u JOIN orders o ON o.user_id = u.id
           WHERE date(o.created_at) BETWEEN ? AND ?
           GROUP BY u.id ORDER BY spent DESC LIMIT 10`,
        )
        .bind(range.from, range.to),
      db.prepare(
        `SELECT u.id, u.username, COUNT(o.id) AS orders, COALESCE(SUM(o.total),0) AS spent
         FROM users u JOIN orders o ON o.user_id = u.id
         GROUP BY u.id HAVING COUNT(o.id) >= 2 ORDER BY orders DESC LIMIT 10`,
      ),
      db.prepare(
        `SELECT u.id, u.username, MAX(o.created_at) AS last_order
         FROM users u LEFT JOIN orders o ON o.user_id = u.id
         WHERE u.role = 'member'
         GROUP BY u.id
         HAVING last_order IS NULL OR last_order < datetime('now', '-60 days')
         ORDER BY last_order ASC LIMIT 10`,
      ),
      db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM (SELECT user_id FROM orders GROUP BY user_id)) AS buyers,
           (SELECT COUNT(*) FROM (SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) >= 2)) AS repeaters`,
      ),
      db.prepare(
        `SELECT COUNT(DISTINCT user_id) AS total FROM orders WHERE created_at >= datetime('now', '-30 days')`,
      ),
      db.prepare("SELECT COUNT(*) AS total FROM users WHERE online_at >= datetime('now', '-5 minutes')"),
    ]);

    const productRows = products.results.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category || '',
      stock: Number(row.stock),
      sold: Number(row.sold || 0),
      revenue: money(row.revenue),
      revenueRaw: Number(row.revenue || 0),
    }));
    const interest = await db
      .prepare('SELECT product_id, COUNT(*) AS total FROM wishlist_items GROUP BY product_id')
      .all();
    const interestMap = new Map(interest.results.map((row) => [Number(row.product_id), Number(row.total)]));

    const totalKeys = keys.results[0] || {};
    const repeatRow = repeat.results[0] || {};

    return {
      range,
      previous: prev,
      overview: {
        revenue: money(totals.results[0].revenue),
        revenueRaw: Number(totals.results[0].revenue || 0),
        orders: Number(totals.results[0].orders),
        buyers: Number(totals.results[0].buyers),
        newMembers: Number(members.results[0].total),
        prevNewMembers: Number(prevMembers.results[0].total),
        prevRevenue: money(prevTotals.results[0].revenue),
        prevRevenueRaw: Number(prevTotals.results[0].revenue || 0),
        prevOrders: Number(prevTotals.results[0].orders),
        activeMembers: Number(activeMembers.results[0].total),
        onlineMembers: Number(onlineMembers.results[0].total),
        totalKeys: Number(totalKeys.total_keys || 0),
        soldKeys: Number(totalKeys.sold_keys || 0),
        availableKeys: Number(totalKeys.available_keys || 0),
        refunds: money(refunds.results[0].refunded),
        refundOrders: Number(refunds.results[0].refund_orders || 0),
        couponUses: Number(coupons.results[0].uses || 0),
        couponDiscount: money(coupons.results[0].discount),
        repeatRate: Number(repeatRow.buyers || 0)
          ? Math.round((Number(repeatRow.repeaters || 0) / Number(repeatRow.buyers)) * 1000) / 10
          : 0,
      },
      series: series.results.map((row) => ({
        day: row.day,
        revenue: money(row.revenue),
        revenueRaw: Number(row.revenue || 0),
        orders: Number(row.orders),
      })),
      products: {
        top: productRows.slice(0, 8),
        bottom: [...productRows].filter((p) => p.sold >= 0).slice(-5).reverse(),
        categories: categories.results.map((row) => ({
          id: row.id,
          name: row.name,
          revenue: money(row.revenue),
          orders: Number(row.orders),
        })),
        interested: productRows
          .map((p) => ({ ...p, interest: interestMap.get(p.id) || 0 }))
          .sort((a, b) => b.interest - a.interest)
          .slice(0, 8),
        lowStock: productRows.filter((p) => p.stock <= 5).sort((a, b) => a.stock - b.stock).slice(0, 10),
      },
      customers: {
        topSpenders: topMembers.results.map((row) => ({
          id: row.id,
          username: row.username,
          spent: money(row.spent),
          orders: Number(row.orders),
        })),
        frequent: frequent.results.map((row) => ({
          id: row.id,
          username: row.username,
          orders: Number(row.orders),
          spent: money(row.spent),
        })),
        inactive: inactive.results.map((row) => ({
          id: row.id,
          username: row.username,
          lastOrder: row.last_order,
        })),
      },
    };
  }

  async function adminAnalytics(ctx) {
    await requirePermission(ctx, 'analytics.view');
    return json(await analyticsData(ctx));
  }

  async function adminAnalyticsExport(ctx) {
    await requirePermission(ctx, 'analytics.view');
    const data = await analyticsData(ctx);
    const rows = [
      ['วันที่', 'รายได้', 'จำนวนออเดอร์'],
      ...data.series.map((row) => [row.day, row.revenueRaw, row.orders]),
      [],
      ['สินค้า', 'หมวดหมู่', 'ขายได้', 'รายได้', 'สต็อก'],
      ...data.products.top.map((p) => [p.name, p.category, p.sold, p.revenueRaw, p.stock]),
      [],
      ['สมาชิก', 'ยอดซื้อ', 'จำนวนออเดอร์'],
      ...data.customers.topSpenders.map((c) => [c.username, c.spent, c.orders]),
      [],
      ['สรุป', 'ค่า'],
      ['ช่วงข้อมูล', `${data.range.from} ถึง ${data.range.to}`],
      ['รายได้รวม', data.overview.revenueRaw],
      ['ออเดอร์', data.overview.orders],
      ['สมาชิกใหม่', data.overview.newMembers],
      ['คูปองที่ใช้', data.overview.couponUses],
      ['คืนเงิน', data.overview.refunds],
    ];
    return csvResponse(rows);
  }

  /* ================================================================ */
  /* 4) WISHLIST                                                      */
  /* ================================================================ */

  async function getWishlist(ctx) {
    const user = requireUser(ctx);
    const db = ctx.env.DB;
    const wishlistId = await ensureWishlist(db, user.id);
    const rows = await db
      .prepare(
        `SELECT wi.id, wi.product_id, wi.price_at_add, wi.created_at, p.name, p.price, p.stock, p.active, c.name AS category
         FROM wishlist_items wi
         JOIN products p ON p.id = wi.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE wi.wishlist_id = ? ORDER BY wi.id DESC`,
      )
      .bind(wishlistId)
      .all();
    const items = rows.results.map((row) => {
      const priceNow = money(row.price);
      const priceAdd = money(row.price_at_add);
      const priceChanged = Number(row.price) !== Number(row.price_at_add);
      return {
        id: row.id,
        productId: row.product_id,
        name: row.name,
        category: row.category || '',
        price: priceNow,
        priceAtAdd: priceAdd,
        priceChanged,
        priceDirection: Number(row.price) > Number(row.price_at_add) ? 'up' : priceChanged ? 'down' : 'same',
        stock: Number(row.stock),
        inStock: Number(row.stock) > 0 && Number(row.active) === 1,
        active: Number(row.active) === 1,
        addedAt: row.created_at,
      };
    });
    return json({
      items,
      stats: {
        total: items.length,
        inStock: items.filter((item) => item.inStock).length,
        priceDrops: items.filter((item) => item.priceDirection === 'down').length,
        backInStock: items.filter((item) => item.priceChanged === false && item.inStock).length,
      },
    });
  }

  async function addWishlist(ctx) {
    const user = requireUser(ctx);
    const db = ctx.env.DB;
    const body = await readJson(ctx.request, 1024);
    const productId = num(body.productId, { label: 'สินค้า', min: 1, max: 1e9, integer: true });
    const product = await db.prepare('SELECT id, price FROM products WHERE id = ?').bind(productId).first();
    if (!product) throw new HttpError(404, 'ไม่พบสินค้านี้');
    const wishlistId = await ensureWishlist(db, user.id);
    const exists = await db
      .prepare('SELECT id FROM wishlist_items WHERE wishlist_id = ? AND product_id = ?')
      .bind(wishlistId, productId)
      .first();
    if (exists) return json({ ok: true, already: true, message: 'สินค้านี้อยู่ในรายการที่สนใจแล้ว' });
    await db
      .prepare('INSERT INTO wishlist_items (wishlist_id, product_id, price_at_add) VALUES (?, ?, ?)')
      .bind(wishlistId, productId, money(product.price))
      .run();
    return json({ ok: true, message: 'เพิ่มในรายการที่สนใจแล้ว' }, 201);
  }

  async function removeWishlist(ctx, productId) {
    const user = requireUser(ctx);
    const db = ctx.env.DB;
    const wishlist = await db.prepare('SELECT id FROM wishlists WHERE user_id = ?').bind(user.id).first();
    if (!wishlist) throw new HttpError(404, 'ไม่พบรายการที่สนใจ');
    const result = await db
      .prepare('DELETE FROM wishlist_items WHERE wishlist_id = ? AND product_id = ?')
      .bind(wishlist.id, Number(productId))
      .run();
    if (Number(result.meta.changes) !== 1) throw new HttpError(404, 'ไม่พบสินค้านี้ในรายการ');
    return json({ ok: true, message: 'ลบออกจากรายการที่สนใจแล้ว' });
  }

  /* ================================================================ */
  /* 5) EMAIL                                                         */
  /* ================================================================ */

  async function adminEmail(ctx) {
    await requirePermission(ctx, 'email.manage');
    const db = ctx.env.DB;
    const config = emailConfig(ctx.env);
    const settings = await db.prepare('SELECT key, value FROM settings').all();
    const map = {};
    for (const row of settings.results) map[row.key] = row.value;
    const logs = await db
      .prepare(
        `SELECT el.*, u.username FROM email_logs el LEFT JOIN users u ON u.id = el.user_id
         ORDER BY el.id DESC LIMIT 100`,
      )
      .all();
    const stats = await db
      .prepare(
        `SELECT status, COUNT(*) AS total FROM email_logs
         WHERE created_at >= datetime('now', '-7 days') GROUP BY status`,
      )
      .all();
    return json({
      config,
      events: Object.entries(EMAIL_EVENTS).map(([key, label]) => ({
        key,
        label,
        enabled: map[`email_event_${key}`] !== '0',
        subject: map[`email_subject_${key}`] || DEFAULT_SUBJECTS[key] || '',
        template: map[`email_template_${key}`] || DEFAULT_TEMPLATES[key] || '',
      })),
      logs: logs.results.map((row) => ({
        id: row.id,
        to: row.to_email,
        username: row.username || '',
        event: row.event,
        subject: row.subject,
        status: row.status,
        provider: row.provider,
        error: row.error,
        createdAt: row.created_at,
      })),
      stats: stats.results.map((row) => ({ status: row.status, total: Number(row.total) })),
    });
  }

  async function adminEmailSettings(ctx) {
    await requirePermission(ctx, 'email.manage');
    const db = ctx.env.DB;
    const body = await readJson(ctx.request, 8192);
    const updates = [];
    if (Array.isArray(body.events)) {
      for (const item of body.events.slice(0, 20)) {
        const key = String(item.key || '');
        if (!EMAIL_EVENTS[key]) continue;
        if (item.enabled !== undefined) {
          updates.push([`email_event_${key}`, item.enabled ? '1' : '0']);
        }
        if (item.subject !== undefined) {
          updates.push([`email_subject_${key}`, String(item.subject).slice(0, 160)]);
        }
        if (item.template !== undefined) {
          updates.push([`email_template_${key}`, String(item.template).slice(0, 4000)]);
        }
      }
    }
    for (const [key, value] of updates) {
      await db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(key, value)
        .run();
    }
    await logStaff(ctx, 'email.settings', `อัปเดตการตั้งค่าอีเมล ${updates.length} รายการ`);
    return json({ ok: true, updated: updates.length });
  }

  async function adminEmailTest(ctx) {
    await requirePermission(ctx, 'email.manage');
    const body = await readJson(ctx.request, 1024);
    const to = str(body.to, { label: 'อีเมลผู้รับ', min: 5, max: 120 });
    const config = emailConfig(ctx.env);
    if (!config.configured) {
      throw new HttpError(400, `ยังไม่ได้ตั้งค่า Email Provider: ${config.reason} — กรุณาตั้ง EMAIL_API_KEY / EMAIL_FROM ใน Secrets`);
    }
    const result = await sendEmail(ctx.env, ctx.env.DB, {
      userId: ctx.user.id,
      to,
      event: 'announcement',
      subject: 'ทดสอบระบบอีเมล VEXIS',
      html: '<p>อีเมลทดสอบจากระบบ VEXIS — หากคุณได้รับข้อความนี้ การตั้งค่าทำงานถูกต้อง</p>',
    });
    await logStaff(ctx, 'email.test', `ส่งทดสอบไป ${to} → ${result.ok ? 'สำเร็จ' : result.reason}`);
    if (!result.ok) throw new HttpError(502, `ส่งอีเมลไม่สำเร็จ (${result.reason}${result.detail ? ': ' + result.detail : ''})`);
    return json({ ok: true, message: 'ส่งอีเมลทดสอบแล้ว' });
  }

  /* ================================================================ */
  /* 6) MULTI-LANGUAGE                                                */
  /* ================================================================ */

  async function getI18n(ctx) {
    const db = ctx.env.DB;
    const locales = await db
      .prepare('SELECT locale, label, native_label, is_default FROM translation_settings WHERE enabled = 1 ORDER BY id ASC')
      .all();
    const strings = await db.prepare('SELECT locale, key, value FROM translation_strings').all();
    const overrides = {};
    for (const row of strings.results) {
      overrides[row.locale] = overrides[row.locale] || {};
      overrides[row.locale][row.key] = row.value;
    }
    return json({
      locales: locales.results.map((row) => ({
        code: row.locale,
        label: row.label,
        nativeLabel: row.native_label,
        isDefault: Number(row.is_default) === 1,
      })),
      defaultLocale: (locales.results.find((row) => Number(row.is_default) === 1) || locales.results[0] || {}).locale || 'th',
      overrides,
      viewerLocale: ctx.user ? ctx.user.locale || 'th' : '',
    });
  }

  async function setLocale(ctx) {
    const body = await readJson(ctx.request, 512);
    const locale = String(body.locale || '').slice(0, 8);
    const row = await ctx.env.DB.prepare(
      'SELECT locale FROM translation_settings WHERE locale = ? AND enabled = 1',
    )
      .bind(locale)
      .first();
    if (!row) throw new HttpError(400, 'ภาษานี้ยังไม่เปิดใช้งาน');
    if (ctx.user) {
      await ctx.env.DB.prepare('UPDATE users SET locale = ? WHERE id = ?').bind(locale, ctx.user.id).run();
    }
    return json({ ok: true, locale });
  }

  async function adminSetTranslation(ctx) {
    if (!ctx.user || ctx.user.role !== 'owner') throw new HttpError(403, 'เฉพาะ Owner เท่านั้น');
    const body = await readJson(ctx.request, 4096);
    const locale = str(body.locale, { label: 'ภาษา', min: 2, max: 8 });
    const key = str(body.key, { label: 'คีย์ข้อความ', min: 1, max: 120 });
    const value = str(body.value, { label: 'คำแปล', min: 1, max: 600 });
    await ctx.env.DB.prepare(
      `INSERT INTO translation_strings (locale, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(locale, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
      .bind(locale, key, value)
      .run();
    await logStaff(ctx, 'i18n.update', `${locale}:${key}`);
    return json({ ok: true });
  }

  /* ================================================================ */
  /* 7) FRAUD                                                         */
  /* ================================================================ */

  async function adminFraud(ctx) {
    await requirePermission(ctx, 'fraud.view');
    const db = ctx.env.DB;
    const status = String(ctx.url.searchParams.get('status') || 'open');
    const risk = String(ctx.url.searchParams.get('risk') || '');
    const where = [];
    const binds = [];
    if (status && status !== 'all') {
      where.push('f.review_status = ?');
      binds.push(status);
    }
    if (risk && risk !== 'all') {
      where.push('f.risk = ?');
      binds.push(risk);
    }
    const rows = await db
      .prepare(
        `SELECT f.*, u.username FROM fraud_events f LEFT JOIN users u ON u.id = f.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY CASE f.risk WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, f.id DESC
         LIMIT 200`,
      )
      .bind(...binds)
      .all();
    return json({
      events: rows.results.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username || '',
        type: row.event_type,
        typeLabel: FRAUD_LABELS[row.event_type] || row.event_type,
        risk: row.risk,
        description: row.description,
        evidence: row.evidence,
        ip: row.ip,
        reviewStatus: row.review_status,
        note: row.note,
        createdAt: row.created_at,
      })),
      summary: await fraudSummary(db),
      reviewStatuses: ['open', 'reviewed', 'dismissed'],
    });
  }

  async function adminFraudReview(ctx, id) {
    const user = await requirePermission(ctx, 'fraud.act');
    const db = ctx.env.DB;
    const body = await readJson(ctx.request, 4096);
    const eventId = Number(id);
    const event = await db.prepare('SELECT * FROM fraud_events WHERE id = ?').bind(eventId).first();
    if (!event) throw new HttpError(404, 'ไม่พบเหตุการณ์นี้');

    const status = String(body.status || 'reviewed');
    if (!['reviewed', 'dismissed', 'open'].includes(status)) throw new HttpError(400, 'สถานะตรวจสอบไม่ถูกต้อง');
    const note = String(body.note || '').slice(0, 300);

    await db
      .prepare('UPDATE fraud_events SET review_status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\'), note = ? WHERE id = ?')
      .bind(status, user.id, note, eventId)
      .run();
    await db
      .prepare('INSERT INTO fraud_reviews (event_id, actor_id, action, note) VALUES (?, ?, ?, ?)')
      .bind(eventId, user.id, `review:${status}`, note)
      .run();
    await logStaff(ctx, 'fraud.review', `#${eventId} → ${status} ${note}`.trim());

    const action = String(body.action || '');
    let restriction = null;
    if (action && event.user_id) {
      if (action === 'restrict') {
        await db
          .prepare('UPDATE users SET restricted = 1, restriction_reason = ? WHERE id = ?')
          .bind(`Fraud #${eventId}: ${event.description}`.slice(0, 200), event.user_id)
          .run();
        restriction = 'restricted';
      } else if (action === 'unlock') {
        await db
          .prepare("UPDATE users SET restricted = 0, restriction_reason = '' WHERE id = ?")
          .bind(event.user_id)
          .run();
        restriction = 'unlocked';
      } else if (action === 'block_transaction') {
        await db
          .prepare('UPDATE users SET restricted = 1, restriction_reason = ? WHERE id = ?')
          .bind(`ระงับธุรกรรมจาก Fraud #${eventId}`, event.user_id)
          .run();
        restriction = 'transactions_blocked';
      }
      if (restriction) {
        await db
          .prepare('INSERT INTO fraud_reviews (event_id, actor_id, action, note) VALUES (?, ?, ?, ?)')
          .bind(eventId, user.id, `action:${restriction}`, note)
          .run();
        await logStaff(ctx, 'fraud.action', `#${eventId} ${restriction} user ${event.user_id}`);
      }
    }
    return json({ ok: true, status, restriction });
  }

  /* ================================================================ */
  /* 8) SYSTEM STATUS                                                 */
  /* ================================================================ */

  async function collectStatus(ctx) {
    const db = ctx.env.DB;
    const checks = await runHealthChecks(ctx.env);
    await logHealthChecks(db, checks);
    const settings = await db.prepare("SELECT key, value FROM settings WHERE key IN ('maintenance_mode','maintenance_message')").all();
    const map = {};
    for (const row of settings.results) map[row.key] = row.value;
    const maintenance = map.maintenance_mode === '1';
    const incidents = await db
      .prepare('SELECT * FROM system_incidents ORDER BY id DESC LIMIT 10')
      .all();
    return {
      checks,
      maintenance,
      maintenanceMessage: map.maintenance_message || '',
      overall: overallStatus(checks, maintenance),
      incidents: incidents.results.map((row) => ({
        id: row.id,
        title: row.title,
        severity: row.severity,
        status: row.status,
        body: row.body,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  async function publicStatus(ctx) {
    const data = await collectStatus(ctx);
    // หน้า public ไม่เปิดเผยรายละเอียดภายใน (เช่น จำนวนผู้ใช้/ยอดเงิน)
    return json({
      overall: data.overall,
      maintenance: data.maintenance,
      maintenanceMessage: data.maintenanceMessage,
      updatedAt: data.updatedAt,
      statuses: Object.fromEntries(Object.entries(STATUS).map(([key, meta]) => [key, meta.label])),
      services: data.checks.map((check) => ({
        key: check.key,
        label: check.label,
        status: check.status,
        latency: check.latency,
        detail:
          check.key === 'notification' || check.status !== 'operational'
            ? check.detail
            : '',
      })),
      incidents: data.incidents.map((row) => ({
        id: row.id,
        title: row.title,
        severity: row.severity,
        status: row.status,
        body: row.body,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      })),
    });
  }

  async function adminStatus(ctx) {
    await requirePermission(ctx, 'status.manage');
    const data = await collectStatus(ctx);
    const logs = await ctx.env.DB.prepare(
      'SELECT service, status, latency_ms, detail, created_at FROM health_check_logs ORDER BY id DESC LIMIT 40',
    ).all();
    return json({
      ...data,
      logs: logs.results,
    });
  }

  async function adminMaintenance(ctx) {
    const user = await requirePermission(ctx, 'status.manage');
    const body = await readJson(ctx.request, 2048);
    const enabled = Boolean(body.enabled);
    const message = String(body.message || '').slice(0, 300);
    const db = ctx.env.DB;
    await db.batch([
      db
        .prepare("INSERT INTO settings (key, value) VALUES ('maintenance_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(enabled ? '1' : '0'),
      db
        .prepare("INSERT INTO settings (key, value) VALUES ('maintenance_message', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(message),
    ]);
    await logStaff(ctx, 'status.maintenance', enabled ? `เปิด Maintenance: ${message}` : 'ปิด Maintenance');
    return json({ ok: true, maintenance: enabled, message });
  }

  async function adminIncidentCreate(ctx) {
    await requirePermission(ctx, 'status.manage');
    const body = await readJson(ctx.request, 4096);
    const title = str(body.title, { label: 'หัวข้อเหตุการณ์', min: 3, max: 120 });
    const severity = ['minor', 'major', 'critical'].includes(body.severity) ? body.severity : 'minor';
    const text = String(body.body || '').slice(0, 1000);
    const startedAt = String(body.startedAt || '').slice(0, 19) || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await ctx.env.DB.prepare(
      "INSERT INTO system_incidents (title, severity, status, body, started_at) VALUES (?, ?, 'investigating', ?, ?)",
    )
      .bind(title, severity, text, startedAt)
      .run();
    await logStaff(ctx, 'status.incident', `${title} (${severity})`);
    return json({ ok: true, id: result.meta.last_row_id }, 201);
  }

  async function adminIncidentUpdate(ctx, id) {
    await requirePermission(ctx, 'status.manage');
    const body = await readJson(ctx.request, 4096);
    const db = ctx.env.DB;
    const incidentId = Number(id);
    const incident = await db.prepare('SELECT * FROM system_incidents WHERE id = ?').bind(incidentId).first();
    if (!incident) throw new HttpError(404, 'ไม่พบเหตุการณ์นี้');
    const status = ['investigating', 'identified', 'monitoring', 'resolved'].includes(body.status)
      ? body.status
      : incident.status;
    const severity = ['minor', 'major', 'critical'].includes(body.severity) ? body.severity : incident.severity;
    const text = body.body === undefined ? incident.body : String(body.body).slice(0, 1000);
    const endedAt =
      status === 'resolved'
        ? String(body.endedAt || '').slice(0, 19) || new Date().toISOString().slice(0, 19).replace('T', ' ')
        : null;
    await db
      .prepare('UPDATE system_incidents SET status = ?, severity = ?, body = ?, ended_at = ? WHERE id = ?')
      .bind(status, severity, text, endedAt, incidentId)
      .run();
    await logStaff(ctx, 'status.incident.update', `#${incidentId} → ${status}`);
    return json({ ok: true, status, endedAt });
  }

  /* ================================================================ */
  /* 9) ADMIN ROLES                                                   */
  /* ================================================================ */

  async function adminRoles(ctx) {
    await requirePermission(ctx, 'roles.manage');
    const db = ctx.env.DB;
    const [roles, staff, assignments, overrides] = await db.batch([
      db.prepare('SELECT key, name, rank, permissions FROM admin_roles ORDER BY rank ASC'),
      db.prepare(
        "SELECT id, username, role, is_root, restricted FROM users WHERE role IN ('owner','admin','moderator','support') ORDER BY id ASC",
      ),
      db.prepare('SELECT user_id, role_key, granted_at FROM admin_role_assignments WHERE revoked_at IS NULL'),
      db.prepare('SELECT user_id, permission, allow FROM admin_permission_assignments'),
    ]);
    const assignedMap = new Map(assignments.results.map((row) => [Number(row.user_id), row]));
    const overridesMap = {};
    for (const row of overrides.results) {
      overridesMap[row.user_id] = overridesMap[row.user_id] || [];
      overridesMap[row.user_id].push({ permission: row.permission, allow: Number(row.allow) === 1 });
    }
    return json({
      roles: roles.results.map((row) => ({
        key: row.key,
        name: row.name,
        rank: Number(row.rank),
        permissions: JSON.parse(row.permissions || '[]'),
      })),
      permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
      staff: staff.results.map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        isRoot: Number(row.is_root) === 1,
        restricted: Number(row.restricted) === 1,
        assignedRole: assignedMap.has(row.id) ? assignedMap.get(row.id).role_key : '',
        overrides: overridesMap[row.id] || [],
      })),
    });
  }

  async function adminAssignRole(ctx) {
    const actor = await requirePermission(ctx, 'roles.manage');
    const db = ctx.env.DB;
    const body = await readJson(ctx.request, 1024);
    const userId = num(body.userId, { label: 'ผู้ใช้', min: 1, max: 1e9, integer: true });
    const roleKey = str(body.roleKey, { label: 'บทบาท', min: 4, max: 20 });

    if (!ADMIN_ROLES[roleKey]) throw new HttpError(400, 'บทบาทไม่ถูกต้อง');
    if (roleKey === 'superadmin' && actor.role !== 'owner') {
      throw new HttpError(403, 'เฉพาะ Owner เท่านั้นที่กำหนด Super Admin ได้');
    }
    const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้นี้');
    if (Number(target.is_root) === 1) throw new HttpError(403, 'ไม่สามารถเปลี่ยนสิทธิ์บัญชี Owner สูงสุดได้');
    if (target.id === actor.id) throw new HttpError(400, 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้');
    if (target.role === 'owner' || target.role === 'superadmin') {
      throw new HttpError(403, 'ไม่สามารถลดสิทธิ์ Super Admin ได้');
    }

    const legacyRole =
      roleKey === 'superadmin' ? 'owner' : roleKey === 'admin' ? 'admin' : roleKey === 'moderator' ? 'moderator' : 'support';

    await db
      .prepare(
        `UPDATE users SET role = ? WHERE id = ?`,
      )
      .bind(legacyRole, userId)
      .run();
    await db
      .prepare(
        `INSERT INTO admin_role_assignments (user_id, role_key, granted_by) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET role_key = excluded.role_key, granted_by = excluded.granted_by,
           granted_at = datetime('now'), revoked_at = NULL`,
      )
      .bind(userId, roleKey, actor.id)
      .run();
    await logStaff(ctx, 'roles.assign', `${target.username}: ${target.role} → ${roleKey}`);
    return json({ ok: true, roleKey, role: legacyRole });
  }

  async function adminRevokeRole(ctx) {
    const actor = await requirePermission(ctx, 'roles.manage');
    const db = ctx.env.DB;
    const body = await readJson(ctx.request, 1024);
    const userId = num(body.userId, { label: 'ผู้ใช้', min: 1, max: 1e9, integer: true });
    const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้นี้');
    if (Number(target.is_root) === 1) throw new HttpError(403, 'ไม่สามารถถอดสิทธิ์ Owner สูงสุดได้');
    if (target.id === actor.id) throw new HttpError(400, 'ไม่สามารถถอดสิทธิ์ของตัวเองได้');
    if (target.role === 'owner') {
      const owners = await db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'owner'").first();
      if (Number(owners.total) <= 1) throw new HttpError(403, 'ต้องมี Super Admin อย่างน้อย 1 คนในระบบ');
    }
    await db.batch([
      db.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(userId),
      db
        .prepare("UPDATE admin_role_assignments SET revoked_at = datetime('now') WHERE user_id = ?")
        .bind(userId),
      db.prepare('DELETE FROM admin_permission_assignments WHERE user_id = ?').bind(userId),
    ]);
    await logStaff(ctx, 'roles.revoke', `${target.username} (${target.role}) → member`);
    return json({ ok: true });
  }

  async function adminPermissionToggle(ctx) {
    const actor = await requirePermission(ctx, 'roles.manage');
    const db = ctx.env.DB;
    const body = await readJson(ctx.request, 1024);
    const userId = num(body.userId, { label: 'ผู้ใช้', min: 1, max: 1e9, integer: true });
    const permission = str(body.permission, { label: 'สิทธิ์', min: 3, max: 40 });
    if (!PERMISSIONS[permission]) throw new HttpError(400, 'ไม่พบสิทธิ์นี้');
    const allow = Boolean(body.allow);
    const target = await db.prepare('SELECT id, username, role, is_root FROM users WHERE id = ?').bind(userId).first();
    if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้นี้');
    if (Number(target.is_root) === 1) throw new HttpError(403, 'ไม่สามารถแก้สิทธิ์ Owner สูงสุดได้');
    if (!['owner', 'admin', 'moderator', 'support'].includes(target.role)) {
      throw new HttpError(400, 'ผู้ใช้นี้ไม่ใช่ทีมงาน กรุณากำหนดบทบาทก่อน');
    }
    await db
      .prepare(
        `INSERT INTO admin_permission_assignments (user_id, permission, allow, granted_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, permission) DO UPDATE SET allow = excluded.allow, granted_by = excluded.granted_by`,
      )
      .bind(userId, permission, allow ? 1 : 0, actor.id)
      .run();
    await logStaff(ctx, 'roles.permission', `${target.username}: ${permission} = ${allow ? 'allow' : 'deny'}`);
    return json({ ok: true, permission, allow });
  }

  /* ================================================================ */
  /* routes                                                           */
  /* ================================================================ */

  const routes = [
    ['GET', /^\/api\/referral$/, myReferral],
    ['GET', /^\/api\/wishlist$/, getWishlist],
    ['POST', /^\/api\/wishlist$/, addWishlist],
    ['DELETE', /^\/api\/wishlist\/(\d+)$/, removeWishlist],
    ['GET', /^\/api\/orders\/(\d+)\/timeline$/, myOrderTimeline],
    ['GET', /^\/api\/i18n$/, getI18n],
    ['POST', /^\/api\/i18n\/preference$/, setLocale],
    ['GET', /^\/api\/status$/, publicStatus],

    ['GET', /^\/api\/admin\/analytics$/, adminAnalytics],
    ['GET', /^\/api\/admin\/analytics\/export$/, adminAnalyticsExport],
    ['GET', /^\/api\/admin\/orders$/, adminListOrders],
    ['GET', /^\/api\/admin\/orders\/(\d+)$/, adminOrderDetail],
    ['POST', /^\/api\/admin\/orders\/(\d+)\/status$/, adminOrderStatus],
    ['GET', /^\/api\/admin\/referral-campaign$/, adminReferralCampaign],
    ['POST', /^\/api\/admin\/referral-campaign$/, adminSaveReferralCampaign],
    ['GET', /^\/api\/admin\/referrals$/, adminReferralList],
    ['GET', /^\/api\/admin\/email$/, adminEmail],
    ['POST', /^\/api\/admin\/email\/settings$/, adminEmailSettings],
    ['POST', /^\/api\/admin\/email\/test$/, adminEmailTest],
    ['POST', /^\/api\/admin\/i18n$/, adminSetTranslation],
    ['GET', /^\/api\/admin\/fraud$/, adminFraud],
    ['POST', /^\/api\/admin\/fraud\/(\d+)\/review$/, adminFraudReview],
    ['GET', /^\/api\/admin\/status$/, adminStatus],
    ['POST', /^\/api\/admin\/status\/maintenance$/, adminMaintenance],
    ['POST', /^\/api\/admin\/status\/incidents$/, adminIncidentCreate],
    ['PATCH', /^\/api\/admin\/status\/incidents\/(\d+)$/, adminIncidentUpdate],
    ['GET', /^\/api\/admin\/roles$/, adminRoles],
    ['POST', /^\/api\/admin\/roles\/assign$/, adminAssignRole],
    ['POST', /^\/api\/admin\/roles\/revoke$/, adminRevokeRole],
    ['POST', /^\/api\/admin\/roles\/permission$/, adminPermissionToggle],
  ];

  /* ---------------- referral admin ---------------- */

  async function adminReferralCampaign(ctx) {
    await requirePermission(ctx, 'referral.manage');
    const db = ctx.env.DB;
    const campaign = await db.prepare('SELECT * FROM referral_campaigns ORDER BY id DESC LIMIT 1').first();
    const totals = await db.batch([
      db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(amount),0) AS paid FROM referral_transactions WHERE kind = 'signup'"),
      db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(amount),0) AS paid FROM referral_transactions WHERE kind = 'purchase'"),
      db.prepare(
        `SELECT rt.*, r.username AS referrer, f.username AS referee
         FROM referral_transactions rt
         LEFT JOIN users r ON r.id = rt.referrer_id
         LEFT JOIN users f ON f.id = rt.referee_id
         ORDER BY rt.id DESC LIMIT 50`,
      ),
    ]);
    return json({
      campaign: campaign
        ? {
            id: campaign.id,
            name: campaign.name,
            enabled: Number(campaign.enabled) === 1,
            signupReward: money(campaign.signup_reward),
            purchaseReward: money(campaign.purchase_reward),
            rewardType: campaign.reward_type,
            maxRewards: Number(campaign.max_rewards),
            startsAt: campaign.starts_at,
            endsAt: campaign.ends_at,
          }
        : null,
      stats: {
        signupCount: Number(totals[0].results[0].total),
        signupPaid: money(totals[0].results[0].paid),
        purchaseCount: Number(totals[1].results[0].total),
        purchasePaid: money(totals[1].results[0].paid),
      },
      transactions: totals[2].results.map((row) => ({
        id: row.id,
        referrer: row.referrer || `#${row.referrer_id}`,
        referee: row.referee || `#${row.referee_id}`,
        kind: row.kind,
        amount: money(row.amount),
        rewardType: row.reward_type,
        status: row.status,
        note: row.note,
        createdAt: row.created_at,
      })),
    });
  }

  async function adminSaveReferralCampaign(ctx) {
    await requirePermission(ctx, 'referral.manage');
    const db = ctx.env.DB;
    const body = await readJson(ctx.request, 4096);
    const current = await db.prepare('SELECT * FROM referral_campaigns ORDER BY id DESC LIMIT 1').first();
    const name = str(body.name ?? current?.name ?? 'แคมเปญเชิญเพื่อน', { label: 'ชื่อแคมเปญ', min: 2, max: 80 });
    const enabled = body.enabled === undefined ? Number(current?.enabled || 0) === 1 : Boolean(body.enabled);
    const signupReward = money(num(body.signupReward ?? current?.signup_reward ?? 0, { label: 'รางวัลผู้สมัคร', min: 0, max: 10000 }));
    const purchaseReward = money(
      num(body.purchaseReward ?? current?.purchase_reward ?? 0, { label: 'รางวัลเพื่อนซื้อ', min: 0, max: 10000 }),
    );
    const rewardType = body.rewardType === 'point' ? 'point' : 'credit';
    const maxRewards = Math.round(
      num(body.maxRewards ?? current?.max_rewards ?? 0, { label: 'จำนวนครั้งสูงสุด', min: 0, max: 100000 }),
    );
    const startsAt = String(body.startsAt ?? current?.starts_at ?? '').slice(0, 10);
    const endsAt = String(body.endsAt ?? current?.ends_at ?? '').slice(0, 10);

    if (current) {
      await db
        .prepare(
          `UPDATE referral_campaigns SET name = ?, enabled = ?, signup_reward = ?, purchase_reward = ?,
             reward_type = ?, max_rewards = ?, starts_at = ?, ends_at = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(name, enabled ? 1 : 0, signupReward, purchaseReward, rewardType, maxRewards, startsAt, endsAt, current.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO referral_campaigns (name, enabled, signup_reward, purchase_reward, reward_type, max_rewards, starts_at, ends_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(name, enabled ? 1 : 0, signupReward, purchaseReward, rewardType, maxRewards, startsAt, endsAt)
        .run();
    }
    await logStaff(ctx, 'referral.campaign', `${name} enabled=${enabled} signup=${signupReward} purchase=${purchaseReward}`);
    return json({ ok: true });
  }

  async function adminReferralList(ctx) {
    await requirePermission(ctx, 'referral.manage');
    const rows = await ctx.env.DB.prepare(
      `SELECT rt.*, r.username AS referrer, f.username AS referee
       FROM referral_transactions rt
       LEFT JOIN users r ON r.id = rt.referrer_id
       LEFT JOIN users f ON f.id = rt.referee_id
       ORDER BY rt.id DESC LIMIT 200`,
    ).all();
    return json({
      transactions: rows.results.map((row) => ({
        id: row.id,
        referrer: row.referrer || `#${row.referrer_id}`,
        referee: row.referee || `#${row.referee_id}`,
        kind: row.kind,
        amount: money(row.amount),
        status: row.status,
        ip: row.ip,
        note: row.note,
        createdAt: row.created_at,
      })),
    });
  }

  return {
    routes,
    helpers: {
      addOrderHistory,
      timelineFor,
      staffGuard,
      recordFraud,
      sendEmail,
      emailConfig,
      findReferrerByCode,
      normalizeReferralCode,
      permissionsFor,
    },
  };
}

export { permissionsFor, requirePermission, ROLE_PERMISSIONS, ADMIN_ROLES, PERMISSIONS };
