/**
 * VEXIS ULTIMATE — แท็บหลังบ้านชุดใหม่
 * Analytics · Order Tracking · Referral Campaign · Email · Fraud · System Status · Admin Roles
 */
import { api, money, escapeHtml, toast, confirmModal, statusPill, formatDate } from './api.js?v=19';

const TAB_PERMISSION = {
  envelope: 'wallet.manage',
  analytics: 'analytics.view',
  orders: 'orders.manage',
  referral: 'referral.manage',
  email: 'email.manage',
  fraud: 'fraud.view',
  status: 'status.manage',
  roles: 'roles.manage',
};

let permsCache = null;

async function perms() {
  if (permsCache) return permsCache;
  try {
    const me = await api('/me');
    permsCache = new Set(me.permissions || []);
  } catch {
    permsCache = new Set();
  }
  return permsCache;
}

export function resetPermsCache() {
  permsCache = null;
}

function spinner() {
  return `<div class="loader"><div class="spinner"></div></div>`;
}

function errorCard(message) {
  return `<div class="card center"><p class="muted">${escapeHtml(message)}</p></div>`;
}

function bars(series, key = 'revenueRaw') {
  if (!series.length) return `<div class="empty-state">ยังไม่มีข้อมูลในช่วงนี้</div>`;
  const max = Math.max(...series.map((row) => Number(row[key]) || 0), 1);
  return `<div class="bar-chart">${series
    .slice(-30)
    .map((row) => {
      const value = Number(row[key]) || 0;
      const height = Math.max(2, Math.round((value / max) * 100));
      return `<div class="bar" title="${escapeHtml(row.day)} · ${money(value)}">
        <div class="bar-fill" style="height:${height}%"></div>
        <span class="bar-label">${escapeHtml(String(row.day).slice(5))}</span>
      </div>`;
    })
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

async function analyticsTab(body, query = '') {
  body.innerHTML = spinner();
  const [overview, store] = await Promise.all([
    api(`/admin/analytics?${query || 'days=30'}`),
    api('/store'),
  ]);
  const filters = `
    <div class="card">
      <div class="row wrap" style="gap:10px;align-items:flex-end">
        <label class="field" style="margin:0"><span>ช่วงเวลา</span>
          <select class="input" data-an-days>
            <option value="7">7 วัน</option>
            <option value="30" selected>30 วัน</option>
            <option value="90">90 วัน</option>
            <option value="365">1 ปี</option>
          </select>
        </label>
        <label class="field" style="margin:0"><span>จากวันที่</span><input class="input" type="date" data-an-from /></label>
        <label class="field" style="margin:0"><span>ถึงวันที่</span><input class="input" type="date" data-an-to /></label>
        <label class="field" style="margin:0"><span>สินค้า</span>
          <select class="input" data-an-product>
            <option value="">ทั้งหมด</option>
            ${store.products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field" style="margin:0"><span>หมวดหมู่</span>
          <select class="input" data-an-category>
            <option value="">ทั้งหมด</option>
            ${store.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-primary btn-sm" data-an-apply>ดูข้อมูล</button>
        <button class="btn btn-ghost btn-sm" data-an-export>Export CSV</button>
      </div>
      <p class="tiny muted" style="margin-top:8px">ข้อมูลช่วง ${overview.range.from} → ${overview.range.to} · คำนวณจากฐานข้อมูลจริง</p>
    </div>`;

  const growth = overview.overview.prevRevenueRaw
    ? Math.round(((overview.overview.revenueRaw - overview.overview.prevRevenueRaw) / overview.overview.prevRevenueRaw) * 1000) / 10
    : null;

  body.innerHTML = `
    ${filters}
    <div class="stat-grid" style="margin-top:14px">
      <div class="stat-card highlight"><div class="label">รายได้รวม</div><div class="value">${overview.overview.revenue}</div>
        <div class="hint">${growth === null ? 'ยังไม่มีข้อมูลช่วงก่อนหน้า' : `${growth >= 0 ? '+' : ''}${growth}% เทียบช่วงก่อน`}</div></div>
      <div class="stat-card"><div class="label">คำสั่งซื้อ</div><div class="value">${overview.overview.orders}</div><div class="hint">ช่วงก่อน ${overview.overview.prevOrders}</div></div>
      <div class="stat-card"><div class="label">สมาชิกใหม่</div><div class="value">${overview.overview.newMembers}</div><div class="hint">ช่วงก่อน ${overview.overview.prevNewMembers}</div></div>
      <div class="stat-card"><div class="label">ออนไลน์ตอนนี้</div><div class="value">${overview.overview.onlineMembers}</div><div class="hint">active 30 วัน ${overview.overview.activeMembers}</div></div>
      <div class="stat-card"><div class="label">คีย์ทั้งหมด / ขายแล้ว</div><div class="value">${overview.overview.totalKeys} / ${overview.overview.soldKeys}</div><div class="hint">พร้อมขาย ${overview.overview.availableKeys}</div></div>
      <div class="stat-card"><div class="label">คูปองถูกใช้</div><div class="value">${overview.overview.couponUses}</div><div class="hint">ส่วนลดรวม ${overview.overview.couponDiscount}</div></div>
      <div class="stat-card"><div class="label">คืนเงิน</div><div class="value">${overview.overview.refunds}</div><div class="hint">${overview.overview.refundOrders} รายการ</div></div>
      <div class="stat-card"><div class="label">อัตราซื้อซ้ำ</div><div class="value">${overview.overview.repeatRate}%</div><div class="hint">สมาชิกที่ซื้อ ≥ 2 ครั้ง</div></div>
    </div>

    <div class="card section" style="margin-top:14px">
      <h3 class="card-title">รายได้รายวัน</h3>
      ${bars(overview.series)}
    </div>

    <div class="two-col" style="margin-top:14px">
      <div class="card">
        <h3 class="card-title">สินค้าขายดี</h3>
        <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>สินค้า</th><th class="t-right">ขาย</th><th class="t-right">รายได้</th></tr></thead>
        <tbody>${overview.products.top.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td class="t-right">${p.sold}</td><td class="t-right">${p.revenue}</td></tr>`).join('') || '<tr><td colspan="3"><div class="empty-state">ไม่มีข้อมูล</div></td></tr>'}</tbody></table></div>
      </div>
      <div class="card">
        <h3 class="card-title">สินค้าใกล้หมด</h3>
        <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>สินค้า</th><th class="t-right">คงเหลือ</th></tr></thead>
        <tbody>${overview.products.lowStock.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td class="t-right" style="color:${p.stock === 0 ? '#ff8d9b' : '#ffcf8a'}">${p.stock}</td></tr>`).join('') || '<tr><td colspan="2"><div class="empty-state">สต็อกเพียงพอ</div></td></tr>'}</tbody></table></div>
      </div>
    </div>

    <div class="two-col" style="margin-top:14px">
      <div class="card">
        <h3 class="card-title">หมวดหมู่ยอดนิยม</h3>
        <div style="margin-top:8px">${overview.products.categories.map((c) => `<div class="kv"><span>${escapeHtml(c.name)}</span><span>${c.revenue} · ${c.orders} ออเดอร์</span></div>`).join('') || '<div class="empty-state">ไม่มีข้อมูล</div>'}</div>
      </div>
      <div class="card">
        <h3 class="card-title">สินค้าที่มีคนสนใจมากที่สุด (Wishlist)</h3>
        <div style="margin-top:8px">${overview.products.interested.filter((p) => p.interest > 0).map((p) => `<div class="kv"><span>${escapeHtml(p.name)}</span><span>${p.interest} คน</span></div>`).join('') || '<div class="empty-state">ยังไม่มีข้อมูล</div>'}</div>
      </div>
    </div>

    <div class="two-col" style="margin-top:14px">
      <div class="card">
        <h3 class="card-title">สมาชิกยอดซื้อสูง</h3>
        <div style="margin-top:8px">${overview.customers.topSpenders.map((c) => `<div class="kv"><span>${escapeHtml(c.username)}</span><span>${c.spent} · ${c.orders} ออเดอร์</span></div>`).join('') || '<div class="empty-state">ไม่มีข้อมูล</div>'}</div>
      </div>
      <div class="card">
        <h3 class="card-title">สมาชิกที่ไม่ได้ใช้งาน</h3>
        <div style="margin-top:8px">${overview.customers.inactive.map((c) => `<div class="kv"><span>${escapeHtml(c.username)}</span><span>${c.lastOrder ? formatDate(c.lastOrder) : 'ยังไม่เคยซื้อ'}</span></div>`).join('') || '<div class="empty-state">ไม่มีข้อมูล</div>'}</div>
      </div>
    </div>
  `;

  const params = (extra = {}) => {
    const query = new URLSearchParams();
    const from = body.querySelector('[data-an-from]').value;
    const to = body.querySelector('[data-an-to]').value;
    if (from && to) {
      query.set('from', from);
      query.set('to', to);
    } else {
      query.set('days', body.querySelector('[data-an-days]').value);
    }
    const product = body.querySelector('[data-an-product]').value;
    const category = body.querySelector('[data-an-category]').value;
    if (product) query.set('productId', product);
    if (category) query.set('categoryId', category);
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return query.toString();
  };

  body.querySelector('[data-an-apply]').addEventListener('click', () => analyticsTab(body, params()));
  body.querySelector('[data-an-export]').addEventListener('click', () => {
    window.open(`/api/admin/analytics/export?${params()}`, '_blank');
  });
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

async function ordersTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/orders?limit=100');
  const rows = data.orders.length
    ? data.orders
        .map(
          (o) => `<tr data-order-row="${o.id}">
            <td class="t-nowrap">#${o.id}</td>
            <td>${escapeHtml(o.username)}</td>
            <td>${escapeHtml(o.productName)} × ${o.quantity}</td>
            <td class="t-right">${o.total}</td>
            <td>${o.couponCode ? escapeHtml(o.couponCode) : '-'}</td>
            <td>${statusPill(o.status)}</td>
            <td class="t-nowrap">${formatDate(o.createdAt)}</td>
            <td><button class="btn btn-sm btn-ghost" data-order-view="${o.id}">ดู/อัปเดต</button></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="8"><div class="empty-state">ยังไม่มีคำสั่งซื้อ</div></td></tr>`;

  body.innerHTML = `
    <div class="card">
      <div class="row wrap" style="gap:10px;align-items:flex-end">
        <label class="field" style="margin:0;min-width:200px"><span>ค้นหา (Order ID / ผู้ใช้ / สินค้า)</span><input class="input" data-order-q placeholder="เช่น 12 หรือ New" /></label>
        <label class="field" style="margin:0"><span>สถานะ</span>
          <select class="input" data-order-status>
            <option value="">ทั้งหมด</option>
            ${data.statusSummary.map((s) => `<option value="${s.status}">${s.status} (${s.total})</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-primary btn-sm" data-order-search>ค้นหา</button>
      </div>
    </div>
    <div class="card section" style="margin-top:14px">
      <div class="table-wrap">
        <table><thead><tr><th>ID</th><th>ผู้ซื้อ</th><th>สินค้า</th><th class="t-right">ยอด</th><th>คูปอง</th><th>สถานะ</th><th>วันที่</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>
    </div>`;

  const openOrder = async (id) => {
    const detail = await api(`/admin/orders/${id}`);
    const steps = detail.steps
      .map(
        (step) => `<div class="timeline-step ${step.done ? 'done' : ''}">
          <div class="timeline-dot">${step.done ? '✓' : '•'}</div>
          <div><strong>${escapeHtml(step.title)}</strong>
            <div class="tiny muted">${escapeHtml(step.note || step.label)}</div>
            <div class="tiny">${step.at ? formatDate(step.at) : 'รอดำเนินการ'}</div>
          </div>
        </div>`,
      )
      .join('');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal">
      <h3>คำสั่งซื้อ #${detail.order.id}</h3>
      <p class="modal-sub">${escapeHtml(detail.order.username)} · ${escapeHtml(detail.order.productName)} · ${detail.order.total}</p>
      <div class="timeline">${steps}</div>
      ${detail.codes.length ? `<pre class="key-box">${escapeHtml(detail.codes.join('\n'))}</pre>` : ''}
      <div class="modal-actions">
        <select class="input" data-status-select style="max-width:200px">
          <option value="processing">Processing</option>
          <option value="key_assigned">Key Assigned</option>
          <option value="delivered">Delivery Completed</option>
          <option value="refunded">Refunded</option>
        </select>
        <input class="input" data-status-note placeholder="หมายเหตุ" style="max-width:200px" />
        <button class="btn btn-primary" data-status-save>บันทึกสถานะ</button>
        <button class="btn btn-ghost" data-modal-close>ปิด</button>
      </div>
    </div>`;
    document.getElementById('modal-root').appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    modal.querySelector('[data-modal-close]').addEventListener('click', close);
    modal.querySelector('[data-status-save]').addEventListener('click', async () => {
      try {
        await api(`/admin/orders/${id}/status`, {
          method: 'POST',
          body: {
            status: modal.querySelector('[data-status-select]').value,
            note: modal.querySelector('[data-status-note]').value,
          },
        });
        toast('อัปเดตสถานะแล้ว', 'success');
        close();
        await ordersTab(body);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  };

  body.querySelectorAll('[data-order-view]').forEach((btn) => {
    btn.addEventListener('click', () => openOrder(btn.dataset.orderView));
  });
  body.querySelector('[data-order-search]').addEventListener('click', async () => {
    const q = body.querySelector('[data-order-q]').value.trim();
    const status = body.querySelector('[data-order-status]').value;
    body.innerHTML = spinner();
    const result = await api(`/admin/orders?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
    body.innerHTML = `<div class="card"><div class="table-wrap"><table><thead><tr><th>ID</th><th>ผู้ซื้อ</th><th>สินค้า</th><th class="t-right">ยอด</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${result.orders.map((o) => `<tr><td>#${o.id}</td><td>${escapeHtml(o.username)}</td><td>${escapeHtml(o.productName)}</td><td class="t-right">${o.total}</td><td>${statusPill(o.status)}</td><td><button class="btn btn-sm btn-ghost" data-order-view="${o.id}">ดู</button></td></tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">ไม่พบคำสั่งซื้อ</div></td></tr>'}
    </tbody></table></div></div>`;
    body.querySelectorAll('[data-order-view]').forEach((btn) => {
      btn.addEventListener('click', () => openOrder(btn.dataset.orderView));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Referral campaign                                                   */
/* ------------------------------------------------------------------ */

async function referralTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/referral-campaign');
  const c = data.campaign || {};
  body.innerHTML = `
    <div class="two-col">
      <div class="card">
        <h3 class="card-title">ตั้งค่าแคมเปญเชิญเพื่อน</h3>
        <label class="field"><span>ชื่อแคมเปญ</span><input class="input" data-ref-name value="${escapeHtml(c.name || 'แคมเปญเชิญเพื่อน VEXIS')}" /></label>
        <label class="field"><span>รางวัลเมื่อเพื่อนสมัคร (บาท/แต้ม)</span><input class="input" type="number" min="0" step="0.01" data-ref-signup value="${Number(String(c.signupReward || '0').replace(/[^0-9.]/g, ''))}" /></label>
        <label class="field"><span>รางวัลเมื่อเพื่อนซื้อครั้งแรก</span><input class="input" type="number" min="0" step="0.01" data-ref-purchase value="${Number(String(c.purchaseReward || '0').replace(/[^0-9.]/g, ''))}" /></label>
        <label class="field"><span>ประเภทรางวัล</span>
          <select class="input" data-ref-type>
            <option value="credit" ${c.rewardType === 'credit' ? 'selected' : ''}>เครดิตกระเป๋า</option>
            <option value="point" ${c.rewardType === 'point' ? 'selected' : ''}>แต้มสะสม</option>
          </select>
        </label>
        <label class="field"><span>จำนวนครั้งสูงสุดที่จ่าย (0 = ไม่จำกัด)</span><input class="input" type="number" min="0" data-ref-max value="${c.maxRewards || 0}" /></label>
        <div class="row" style="gap:10px">
          <label class="field" style="flex:1"><span>วันเริ่ม</span><input class="input" type="date" data-ref-start value="${escapeHtml(c.startsAt || '')}" /></label>
          <label class="field" style="flex:1"><span>วันสิ้นสุด</span><input class="input" type="date" data-ref-end value="${escapeHtml(c.endsAt || '')}" /></label>
        </div>
        <label class="row" style="gap:8px;margin:8px 0 14px"><input type="checkbox" data-ref-enabled ${c.enabled ? 'checked' : ''} /><span>เปิดใช้งานแคมเปญ</span></label>
        <button class="btn btn-primary btn-block" data-ref-save>บันทึกแคมเปญ</button>
      </div>
      <div class="stack">
        <div class="card">
          <h3 class="card-title">สถิติรางวัล</h3>
          <div class="kv"><span>รางวัลจากการสมัคร</span><span>${data.stats.signupCount} ครั้ง · ${data.stats.signupPaid}</span></div>
          <div class="kv"><span>รางวัลจากการซื้อ</span><span>${data.stats.purchaseCount} ครั้ง · ${data.stats.purchasePaid}</span></div>
        </div>
        <div class="card">
          <h3 class="card-title">ธุรกรรมล่าสุด</h3>
          <div style="margin-top:8px;max-height:340px;overflow:auto">
            ${data.transactions
              .map(
                (t) => `<div class="list-row"><div><strong>${escapeHtml(t.referrer)}</strong> → ${escapeHtml(t.referee)}
                  <div class="tiny muted">${t.kind === 'signup' ? 'สมัคร' : 'ซื้อครั้งแรก'} · ${formatDate(t.createdAt)}</div></div>
                  <span class="pill pill-approved">${t.amount}</span></div>`,
              )
              .join('') || '<div class="empty-state">ยังไม่มีธุรกรรม</div>'}
          </div>
        </div>
      </div>
    </div>`;

  body.querySelector('[data-ref-save]').addEventListener('click', async () => {
    try {
      await api('/admin/referral-campaign', {
        method: 'POST',
        body: {
          name: body.querySelector('[data-ref-name]').value,
          signupReward: Number(body.querySelector('[data-ref-signup]').value),
          purchaseReward: Number(body.querySelector('[data-ref-purchase]').value),
          rewardType: body.querySelector('[data-ref-type]').value,
          maxRewards: Number(body.querySelector('[data-ref-max]').value),
          startsAt: body.querySelector('[data-ref-start]').value,
          endsAt: body.querySelector('[data-ref-end]').value,
          enabled: body.querySelector('[data-ref-enabled]').checked,
        },
      });
      toast('บันทึกแคมเปญแล้ว', 'success');
      await referralTab(body);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

async function emailTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/email');
  const configBanner = data.config.configured
    ? `<div class="card" style="border-color:rgba(47,208,127,.3);background:rgba(47,208,127,.06)">
         <strong>Email Provider พร้อมใช้งาน</strong>
         <p class="small" style="margin-top:4px">${escapeHtml(data.config.provider)} · ผู้ส่ง ${escapeHtml(data.config.from)}</p>
       </div>`
    : `<div class="card" style="border-color:rgba(255,196,102,.3);background:rgba(255,196,102,.06)">
         <strong>Not Configured — ยังไม่ได้ตั้งค่า Email Provider</strong>
         <p class="small" style="margin-top:6px">อีเมลจะไม่ถูกส่งจริง ระบบบันทึกสถานะรอไว้เท่านั้น<br>
         วิธีตั้งค่า: ใส่ Secret ของ Worker ชื่อ <code>EMAIL_API_KEY</code>, <code>EMAIL_FROM</code> และ <code>EMAIL_PROVIDER</code> (resend) แล้ว redeploy</p>
       </div>`;

  body.innerHTML = `
    ${configBanner}
    <div class="card section" style="margin-top:14px">
      <h3 class="card-title">ประเภทอีเมลแจ้งเตือน</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table><thead><tr><th>เหตุการณ์</th><th>เปิด/ปิด</th><th>หัวข้ออีเมล</th><th>Template</th></tr></thead>
        <tbody>
          ${data.events
            .map(
              (ev) => `<tr>
                <td>${escapeHtml(ev.label)}<div class="tiny muted">${escapeHtml(ev.key)}</div></td>
                <td><input type="checkbox" data-ev-toggle="${ev.key}" ${ev.enabled ? 'checked' : ''} /></td>
                <td><input class="input" data-ev-subject="${ev.key}" value="${escapeHtml(ev.subject)}" /></td>
                <td><textarea class="input" rows="2" data-ev-template="${ev.key}">${escapeHtml(ev.template)}</textarea></td>
              </tr>`,
            )
            .join('')}
        </tbody></table>
      </div>
      <div class="row wrap" style="gap:10px;margin-top:12px">
        <button class="btn btn-primary btn-sm" data-ev-save>บันทึกการตั้งค่า</button>
        <input class="input" data-ev-test-to placeholder="อีเมลทดสอบ" style="max-width:220px" />
        <button class="btn btn-ghost btn-sm" data-ev-test>ส่งทดสอบ</button>
      </div>
    </div>

    <div class="card section" style="margin-top:14px">
      <h3 class="card-title">ประวัติการส่ง</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table><thead><tr><th>เวลา</th><th>ผู้รับ</th><th>เหตุการณ์</th><th>สถานะ</th><th>รายละเอียด</th></tr></thead>
        <tbody>
          ${data.logs
            .map(
              (log) => `<tr><td class="t-nowrap">${formatDate(log.createdAt)}</td><td>${escapeHtml(log.to || '-')}</td>
                <td>${escapeHtml(log.event)}</td><td>${statusPill(log.status === 'sent' ? 'approved' : log.status === 'failed' ? 'rejected' : 'pending')}
                <span class="tiny">${escapeHtml(log.status)}</span></td><td class="tiny">${escapeHtml(log.error || log.provider || '')}</td></tr>`,
            )
            .join('') || '<tr><td colspan="5"><div class="empty-state">ยังไม่มีประวัติการส่ง</div></td></tr>'}
        </tbody></table>
      </div>
    </div>`;

  body.querySelector('[data-ev-save]').addEventListener('click', async () => {
    const events = data.events.map((ev) => ({
      key: ev.key,
      enabled: body.querySelector(`[data-ev-toggle="${ev.key}"]`).checked,
      subject: body.querySelector(`[data-ev-subject="${ev.key}"]`).value,
      template: body.querySelector(`[data-ev-template="${ev.key}"]`).value,
    }));
    try {
      await api('/admin/email/settings', { method: 'POST', body: { events } });
      toast('บันทึกการตั้งค่าอีเมลแล้ว', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  body.querySelector('[data-ev-test]').addEventListener('click', async () => {
    const to = body.querySelector('[data-ev-test-to]').value.trim();
    try {
      await api('/admin/email/test', { method: 'POST', body: { to } });
      toast('ส่งอีเมลทดสอบแล้ว', 'success');
      await emailTab(body);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Fraud                                                               */
/* ------------------------------------------------------------------ */

async function fraudTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/fraud?status=open');
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card highlight"><div class="label">รอตรวจสอบ</div><div class="value">${data.summary.openTotal}</div></div>
      <div class="stat-card"><div class="label">Critical</div><div class="value" style="color:#ff8d9b">${data.summary.open.critical}</div></div>
      <div class="stat-card"><div class="label">High</div><div class="value" style="color:#ffcf8a">${data.summary.open.high}</div></div>
      <div class="stat-card"><div class="label">เหตุการณ์ 24 ชม.</div><div class="value">${data.summary.last24h}</div></div>
      <div class="stat-card"><div class="label">บัญชีถูกระงับ</div><div class="value">${data.summary.restrictedUsers}</div></div>
    </div>

    <div class="card section" style="margin-top:14px">
      <div class="row wrap" style="gap:10px;align-items:flex-end">
        <label class="field" style="margin:0"><span>สถานะตรวจ</span>
          <select class="input" data-fraud-status>
            <option value="open">รอตรวจ</option>
            <option value="reviewed">ตรวจแล้ว</option>
            <option value="dismissed">ยกเลิก</option>
            <option value="all">ทั้งหมด</option>
          </select>
        </label>
        <label class="field" style="margin:0"><span>ระดับความเสี่ยง</span>
          <select class="input" data-fraud-risk>
            <option value="all">ทั้งหมด</option>
            <option value="critical">critical</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </label>
        <button class="btn btn-primary btn-sm" data-fraud-filter>กรอง</button>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="table-wrap">
        <table><thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>ประเภท</th><th>ความเสี่ยง</th><th>รายละเอียด</th><th></th></tr></thead>
        <tbody>
          ${data.events
            .map(
              (ev) => `<tr>
                <td class="t-nowrap">${formatDate(ev.createdAt)}</td>
                <td>${escapeHtml(ev.username || 'ไม่ระบุ')}<div class="tiny muted">${ev.ip ? escapeHtml(ev.ip) : ''}</div></td>
                <td>${escapeHtml(ev.typeLabel)}</td>
                <td><span class="pill ${ev.risk === 'critical' || ev.risk === 'high' ? 'pill-rejected' : ev.risk === 'medium' ? 'pill-pending' : 'pill-open'}">${ev.risk}</span></td>
                <td class="tiny">${escapeHtml(ev.description)}</td>
                <td><button class="btn btn-sm btn-ghost" data-fraud-review="${ev.id}">ตรวจสอบ</button></td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="6"><div class="empty-state">ไม่มีเหตุการณ์ผิดปกติ</div></td></tr>'}
        </tbody></table>
      </div>
    </div>`;

  body.querySelector('[data-fraud-filter]').addEventListener('click', async () => {
    const status = body.querySelector('[data-fraud-status]').value;
    const risk = body.querySelector('[data-fraud-risk]').value;
    body.innerHTML = spinner();
    const next = await api(`/admin/fraud?status=${status}&risk=${risk}`);
    body.innerHTML = '';
    const holder = document.createElement('div');
    holder.innerHTML = '';
    body.appendChild(holder);
    // วาดใหม่ทั้งแท็บด้วยตัวกรอง (เรียกซ้ำแบบง่าย)
    await fraudTab(body);
    toast(`กรองแล้ว: ${next.events.length} เหตุการณ์`, 'info');
  });

  body.querySelectorAll('[data-fraud-review]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ev = data.events.find((row) => String(row.id) === btn.dataset.fraudReview);
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `<div class="modal">
        <h3>ตรวจสอบเหตุการณ์ #${ev.id}</h3>
        <p class="modal-sub">${escapeHtml(ev.typeLabel)} · ${ev.risk} · ${escapeHtml(ev.username || 'ไม่ระบุผู้ใช้')}</p>
        <p class="small">${escapeHtml(ev.description)}</p>
        ${ev.evidence ? `<pre class="key-box tiny">${escapeHtml(ev.evidence)}</pre>` : ''}
        <label class="field"><span>บันทึกภายใน</span><input class="input" data-review-note placeholder="เหตุผล/หมายเหตุ" /></label>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-review-dismiss>ปิด</button>
          <button class="btn btn-ghost" data-review-done>Mark as Reviewed</button>
          <button class="btn btn-danger" data-review-restrict>Restrict Account</button>
          <button class="btn btn-primary" data-review-unlock>Unlock Account</button>
        </div>
      </div>`;
      document.getElementById('modal-root').appendChild(modal);
      const close = () => modal.remove();
      modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
      });
      modal.querySelector('[data-review-dismiss]').addEventListener('click', close);
      const send = async (status, action) => {
        try {
          await api(`/admin/fraud/${ev.id}/review`, {
            method: 'POST',
            body: { status, action, note: modal.querySelector('[data-review-note]').value },
          });
          toast('บันทึกผลตรวจแล้ว', 'success');
          close();
          await fraudTab(body);
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      modal.querySelector('[data-review-done]').addEventListener('click', () => send('reviewed', ''));
      modal.querySelector('[data-review-restrict]').addEventListener('click', () => send('reviewed', 'restrict'));
      modal.querySelector('[data-review-unlock]').addEventListener('click', () => send('reviewed', 'unlock'));
    });
  });
}

/* ------------------------------------------------------------------ */
/* System status                                                       */
/* ------------------------------------------------------------------ */

async function statusTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/status');
  const services = data.checks
    .map(
      (check) => `<div class="list-row"><div><strong>${escapeHtml(check.label)}</strong>
        <div class="tiny muted">${escapeHtml(check.detail || '')}</div></div>
        <div class="row" style="gap:10px"><span class="tiny muted">${check.latency} ms</span>
        <span class="pill ${check.status === 'operational' ? 'pill-approved' : check.status === 'unknown' ? 'pill-open' : 'pill-rejected'}">${escapeHtml(check.status)}</span></div></div>`,
    )
    .join('');

  body.innerHTML = `
    <div class="card">
      <div class="row between wrap">
        <div><h3 class="card-title">สถานะรวม: ${escapeHtml(data.overall)}</h3>
          <p class="tiny muted">ตรวจล่าสุด ${new Date(data.updatedAt).toLocaleString('th-TH')} — ผลจาก Health Check จริง</p></div>
        <div class="row" style="gap:8px">
          <input class="input" data-maint-message placeholder="ข้อความปิดปรับปรุง" value="${escapeHtml(data.maintenanceMessage || '')}" style="max-width:240px" />
          <label class="row" style="gap:6px"><input type="checkbox" data-maint-toggle ${data.maintenance ? 'checked' : ''} /><span>Maintenance</span></label>
          <button class="btn btn-primary btn-sm" data-maint-save>บันทึก</button>
        </div>
      </div>
      <div style="margin-top:12px">${services}</div>
    </div>

    <div class="two-col" style="margin-top:14px">
      <div class="card">
        <h3 class="card-title">บันทึกเหตุการณ์ขัดข้อง</h3>
        <label class="field"><span>หัวข้อ</span><input class="input" data-inc-title placeholder="เช่น API ช้าผิดปกติ" /></label>
        <label class="field"><span>ระดับ</span>
          <select class="input" data-inc-severity>
            <option value="minor">minor</option>
            <option value="major">major</option>
            <option value="critical">critical</option>
          </select>
        </label>
        <label class="field"><span>รายละเอียด</span><textarea class="input" rows="3" data-inc-body></textarea></label>
        <button class="btn btn-primary btn-block" data-inc-create>บันทึกเหตุการณ์</button>
      </div>
      <div class="card">
        <h3 class="card-title">ประวัติ Incident</h3>
        <div style="margin-top:8px;max-height:320px;overflow:auto">
          ${data.incidents
            .map(
              (inc) => `<div class="list-row"><div><strong>${escapeHtml(inc.title)}</strong>
                <div class="tiny muted">${formatDate(inc.startedAt)}${inc.endedAt ? ` → ${formatDate(inc.endedAt)}` : ''} · ${inc.severity}</div></div>
                <div class="row" style="gap:6px"><span class="pill ${inc.status === 'resolved' ? 'pill-approved' : 'pill-pending'}">${inc.status}</span>
                ${inc.status !== 'resolved' ? `<button class="btn btn-sm btn-ghost" data-inc-resolve="${inc.id}">ปิดเหตุ</button>` : ''}</div></div>`,
            )
            .join('') || '<div class="empty-state">ไม่มีเหตุการณ์</div>'}
        </div>
      </div>
    </div>

    <div class="card section" style="margin-top:14px">
      <h3 class="card-title">Health Check Log ล่าสุด</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table><thead><tr><th>เวลา</th><th>บริการ</th><th>สถานะ</th><th class="t-right">latency</th><th>รายละเอียด</th></tr></thead>
        <tbody>${data.logs
          .map(
            (log) => `<tr><td class="t-nowrap">${formatDate(log.created_at)}</td><td>${escapeHtml(log.service)}</td>
              <td>${escapeHtml(log.status)}</td><td class="t-right">${log.latency_ms} ms</td><td class="tiny">${escapeHtml(log.detail || '')}</td></tr>`,
          )
          .join('') || '<tr><td colspan="5"><div class="empty-state">ยังไม่มี log</div></td></tr>'}</tbody></table>
      </div>
    </div>`;

  body.querySelector('[data-maint-save]').addEventListener('click', async () => {
    try {
      await api('/admin/status/maintenance', {
        method: 'POST',
        body: {
          enabled: body.querySelector('[data-maint-toggle]').checked,
          message: body.querySelector('[data-maint-message]').value,
        },
      });
      toast('บันทึกโหมด Maintenance แล้ว', 'success');
      await statusTab(body);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  body.querySelector('[data-inc-create]').addEventListener('click', async () => {
    try {
      await api('/admin/status/incidents', {
        method: 'POST',
        body: {
          title: body.querySelector('[data-inc-title]').value,
          severity: body.querySelector('[data-inc-severity]').value,
          body: body.querySelector('[data-inc-body]').value,
        },
      });
      toast('บันทึกเหตุการณ์แล้ว', 'success');
      await statusTab(body);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  body.querySelectorAll('[data-inc-resolve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/admin/status/incidents/${btn.dataset.incResolve}`, { method: 'PATCH', body: { status: 'resolved' } });
        toast('ปิดเหตุการณ์แล้ว', 'success');
        await statusTab(body);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Admin roles                                                         */
/* ------------------------------------------------------------------ */

async function rolesTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/roles');
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">บทบาทและสิทธิ์ (RBAC)</h3>
      <p class="tiny muted" style="margin-top:4px">สิทธิ์ถูกตรวจจากฐานข้อมูลฝั่งเซิร์ฟเวอร์ทุกคำขอ — UI นี้เป็นเพียงตัวจัดการ</p>
      <div class="role-grid" style="margin-top:12px">
        ${data.roles
          .map(
            (role) => `<div class="card inner">
              <strong>${escapeHtml(role.name)}</strong>
              <div class="tiny muted">${role.permissions.length} สิทธิ์</div>
              <div class="tiny" style="margin-top:6px">${role.permissions.map((p) => `<span class="pill pill-open" style="margin:2px">${escapeHtml(p)}</span>`).join('')}</div>
            </div>`,
          )
          .join('')}
      </div>
    </div>

    <div class="card section" style="margin-top:14px">
      <h3 class="card-title">ทีมงาน</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table><thead><tr><th>ผู้ใช้</th><th>ยศปัจจุบัน</th><th>บทบาทที่กำหนด</th><th>กำหนดบทบาท</th><th></th></tr></thead>
        <tbody>
          ${data.staff
            .map(
              (user) => `<tr>
                <td>${escapeHtml(user.username)}${user.isRoot ? ' <span class="pill pill-approved">ROOT</span>' : ''}</td>
                <td>${escapeHtml(user.role)}</td>
                <td>${escapeHtml(user.assignedRole || '-')}</td>
                <td>
                  <select class="input" data-role-select="${user.id}" ${user.isRoot ? 'disabled' : ''}>
                    ${data.roles.map((role) => `<option value="${role.key}" ${user.assignedRole === role.key ? 'selected' : ''}>${role.name}</option>`).join('')}
                  </select>
                </td>
                <td class="row" style="gap:6px">
                  <button class="btn btn-sm btn-primary" data-role-assign="${user.id}" ${user.isRoot ? 'disabled' : ''}>บันทึก</button>
                  <button class="btn btn-sm btn-ghost" data-role-perm="${user.id}" ${user.isRoot ? 'disabled' : ''}>สิทธิ์</button>
                  <button class="btn btn-sm btn-danger" data-role-revoke="${user.id}" ${user.isRoot ? 'disabled' : ''}>ถอดสิทธิ์</button>
                </td>
              </tr>`,
            )
            .join('')}
        </tbody></table>
      </div>
    </div>`;

  body.querySelectorAll('[data-role-assign]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.roleAssign;
      const roleKey = body.querySelector(`[data-role-select="${userId}"]`).value;
      try {
        await api('/admin/roles/assign', { method: 'POST', body: { userId: Number(userId), roleKey } });
        toast('อัปเดตบทบาทแล้ว', 'success');
        resetPermsCache();
        await rolesTab(body);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  body.querySelectorAll('[data-role-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.roleRevoke;
      const ok = await confirmModal({
        title: 'ถอดสิทธิ์ทีมงาน',
        message: 'ผู้ใช้นี้จะถูกเปลี่ยนกลับเป็น Member และสิทธิ์ที่กำหนดไว้จะถูกล้าง',
        confirmText: 'ถอดสิทธิ์',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('/admin/roles/revoke', { method: 'POST', body: { userId: Number(userId) } });
        toast('ถอดสิทธิ์แล้ว', 'success');
        await rolesTab(body);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  body.querySelectorAll('[data-role-perm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.rolePerm;
      const user = data.staff.find((row) => String(row.id) === userId);
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `<div class="modal">
        <h3>กำหนดสิทธิ์: ${escapeHtml(user.username)}</h3>
        <p class="modal-sub">ติ๊ก = อนุญาต, ว่าง = ใช้ค่าเริ่มต้นของบทบาท</p>
        <div style="max-height:340px;overflow:auto">
          ${data.permissions
            .map((perm) => {
              const override = (user.overrides || []).find((row) => row.permission === perm.key);
              const baseHas = data.roles.find((r) => r.key === user.assignedRole)?.permissions.includes(perm.key);
              return `<label class="row" style="gap:8px;padding:4px 0">
                <input type="checkbox" data-perm="${perm.key}" ${override ? (override.allow ? 'checked' : '') : baseHas ? 'checked' : ''} />
                <span>${escapeHtml(perm.label)} <span class="tiny muted">${escapeHtml(perm.key)}</span></span>
              </label>`;
            })
            .join('')}
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-perm-close>ปิด</button>
          <button class="btn btn-primary" data-perm-save>บันทึกสิทธิ์</button>
        </div>
      </div>`;
      document.getElementById('modal-root').appendChild(modal);
      const close = () => modal.remove();
      modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
      });
      modal.querySelector('[data-perm-close]').addEventListener('click', close);
      modal.querySelector('[data-perm-save]').addEventListener('click', async () => {
        const rolePerms = data.roles.find((r) => r.key === user.assignedRole)?.permissions || [];
        const changes = [];
        modal.querySelectorAll('[data-perm]').forEach((box) => {
          const key = box.dataset.perm;
          const base = rolePerms.includes(key);
          if (box.checked !== base) changes.push({ permission: key, allow: box.checked });
        });
        try {
          for (const change of changes) {
            await api('/admin/roles/permission', { method: 'POST', body: { userId: user.id, ...change } });
          }
          toast(`อัปเดตสิทธิ์ ${changes.length} รายการ`, 'success');
          close();
          await rolesTab(body);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  });
}

/* ------------------------------------------------------------------ */

export const ULTIMATE_TABS = [
  ['envelope', 'ซองทรู'],
  ['analytics', 'Analytics'],
  ['orders', 'คำสั่งซื้อ'],
  ['referral', 'เชิญเพื่อน'],
  ['email', 'อีเมล'],
  ['fraud', 'ตรวจการทุจริต'],
  ['status', 'สถานะระบบ'],
  ['roles', 'สิทธิ์แอดมิน'],
];

/* ------------------------------------------------------------------ */
/* TrueMoney Gift Envelope desk                                        */
/* ------------------------------------------------------------------ */

const TM_STATUS = {
  pending: ['รอตรวจสอบ', 'pill-pending'],
  verifying: ['กำลังตรวจสอบ', 'pill-pending'],
  approved: ['อนุมัติแล้ว', 'pill-approved'],
  rejected: ['ปฏิเสธ', 'pill-rejected'],
  expired: ['หมดอายุ', 'pill-rejected'],
  duplicate: ['รายการซ้ำ', 'pill-rejected'],
};

function tmPill(status) {
  const [label, cls] = TM_STATUS[status] || [status, 'pill-open'];
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

async function envelopeTab(body, query = '') {
  body.innerHTML = spinner();
  const data = await api(`/admin/topups/envelope?${query || 'status=all'}`);
  const configBanner = data.verification.configured
    ? `<div class="card" style="border-color:rgba(47,208,127,.3);background:rgba(47,208,127,.06)">
        <strong>ตรวจสอบอัตโนมัติ: ${escapeHtml(data.verification.status)}</strong>
        <p class="small" style="margin-top:4px">${escapeHtml(data.verification.message)}</p></div>`
    : `<div class="card" style="border-color:rgba(255,196,102,.3);background:rgba(255,196,102,.06)">
        <strong>ตรวจสอบอัตโนมัติ: Not Configured</strong>
        <p class="small" style="margin-top:6px">ยังไม่มีช่องทางตรวจสอบซองที่ได้รับอนุญาต — ทุกคำขอจะเป็นการตรวจสอบด้วยแอดมิน (ระบบไม่เติมเครดิตอัตโนมัติ)</p>
        <p class="tiny" style="margin-top:4px">เชื่อมต่อได้โดยตั้ง Secrets <code>TRUEMONEY_RELAY_URL</code> + <code>TRUEMONEY_RELAY_TOKEN</code> และรัน relay ของร้าน</p></div>`;

  body.innerHTML = `
    ${configBanner}
    <div class="stat-grid" style="margin-top:14px">
      <div class="stat-card highlight"><div class="label">อนุมัติแล้ว (ซองทรู)</div><div class="value">฿${data.totals.approvedAmount}</div><div class="hint">${data.totals.approvedCount} รายการ</div></div>
      <div class="stat-card"><div class="label">ค่าธรรมเนียมรวม</div><div class="value">฿${data.totals.feeTotal}</div><div class="hint">เครดิตที่จ่ายจริง ฿${data.totals.netTotal}</div></div>
      <div class="stat-card"><div class="label">รอตรวจสอบ</div><div class="value">${data.totals.pendingCount}</div><div class="hint">ต้องยืนยันยอดจริงก่อนอนุมัติ</div></div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="row wrap" style="gap:10px;align-items:flex-end">
        <label class="field" style="margin:0;min-width:220px"><span>ค้นหา Username / Transaction ID / Voucher</span>
          <input class="input" data-tm-q placeholder="เช่น New หรือ 12" /></label>
        <label class="field" style="margin:0"><span>สถานะ</span>
          <select class="input" data-tm-status>
            ${['all', 'pending', 'verifying', 'approved', 'rejected', 'expired', 'duplicate']
              .map((key) => `<option value="${key}">${key === 'all' ? 'ทั้งหมด' : (TM_STATUS[key]?.[0] || key)}</option>`)
              .join('')}
          </select></label>
        <button class="btn btn-primary btn-sm" data-tm-search>ค้นหา</button>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="table-wrap">
        <table><thead><tr><th>ID</th><th>เวลา</th><th>สมาชิก</th><th>Voucher</th><th class="t-right">ยอดจริง</th><th class="t-right">ค่าธรรมเนียม</th><th class="t-right">เครดิต</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>
          ${data.topups
            .map(
              (t) => `<tr>
                <td class="t-nowrap">#${t.id}</td>
                <td class="t-nowrap">${formatDate(t.createdAt)}</td>
                <td>${escapeHtml(t.username || '-')}</td>
                <td class="tiny mono">${t.voucherCode ? escapeHtml(t.voucherCode.slice(0, 14)) : '-'}</td>
                <td class="t-right">${t.amount}</td>
                <td class="t-right">${t.fee}</td>
                <td class="t-right" style="color:#7ff0b5">${t.net}</td>
                <td>${tmPill(t.status)}</td>
                <td><button class="btn btn-sm btn-ghost" data-tm-open="${t.id}">ตรวจสอบ</button></td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="9"><div class="empty-state">ยังไม่มีคำขอเติมเงินซองทรู</div></td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="card section" style="margin-top:14px">
      <h3 class="card-title">ประวัติการตรวจสอบ (Verification Log)</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table><thead><tr><th>เวลา</th><th>รายการ</th><th>การกระทำ</th><th>โดย</th><th class="t-right">ยอดจริง</th><th>หลักฐาน/หมายเหตุ</th></tr></thead>
        <tbody>${data.logs
          .map(
            (log) => `<tr><td class="t-nowrap">${formatDate(log.createdAt)}</td><td>#${log.topupId}<div class="tiny muted">${escapeHtml(log.member || '')}</div></td>
              <td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.actor)}</td><td class="t-right">${log.amount}</td>
              <td class="tiny">${escapeHtml(log.evidence || log.note || '')}</td></tr>`,
          )
          .join('') || '<tr><td colspan="6"><div class="empty-state">ยังไม่มีประวัติ</div></td></tr>'}</tbody></table>
      </div>
    </div>`;

  body.querySelector('[data-tm-search]').addEventListener('click', () => {
    const q = body.querySelector('[data-tm-q]').value.trim();
    const status = body.querySelector('[data-tm-status]').value;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    params.set('status', status);
    envelopeTab(body, params.toString());
  });

  body.querySelectorAll('[data-tm-open]').forEach((btn) => {
    btn.addEventListener('click', () => openEnvelope(btn.dataset.tmOpen, body));
  });
}

async function openEnvelope(id, body) {
  const detail = await api(`/admin/topups/${id}`);
  const t = detail.topup;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const canAct = ['pending', 'verifying'].includes(t.status);
  modal.innerHTML = `<div class="modal">
    <h3>คำขอเติมเงิน #${t.id}</h3>
    <p class="modal-sub">${escapeHtml(t.username)} · ${formatDate(t.createdAt)} · ${tmPill(t.status)}</p>
    <div class="kv"><span>ยอดที่สมาชิกแจ้ง</span><span>${t.declaredAmount}</span></div>
    <div class="kv"><span>ยอดจริงที่ตรวจได้</span><span>${t.amount}</span></div>
    <div class="kv"><span>ค่าธรรมเนียม</span><span>${t.fee}</span></div>
    <div class="kv"><span>เครดิตที่เข้า</span><span>${t.net}</span></div>
    <div class="kv"><span>แหล่งตรวจสอบ</span><span>${escapeHtml(t.verificationSource)}</span></div>
    <div class="kv"><span>กระเป๋า</span><span>${t.balanceBefore} → ${t.balanceAfter}</span></div>
    <div class="field" style="margin-top:10px"><label>ลิงก์ซอง</label>
      <input class="input mono" readonly value="${escapeHtml(t.reference)}" /></div>
    ${canAct ? `<div class="field"><label>ยอดจริงในซอง (ยืนยันจากการตรวจสอบ)</label>
      <input class="input" type="number" step="0.01" min="0.01" data-tm-amount value="${Number(String(t.declaredAmount).replace(/[^0-9.]/g, '')) || 0}" /></div>
    <div class="field"><label>หลักฐานการตรวจสอบ</label>
      <input class="input" data-tm-evidence placeholder="เช่น ตรวจในแอป TrueMoney เมื่อ 14:20 เลขที่ TX…" /></div>
    <div class="field"><label>เหตุผล (จำเป็นเมื่อปฏิเสธ)</label>
      <input class="input" data-tm-note placeholder="ระบุเหตุผล" /></div>` : ''}
    <div class="timeline">${detail.verifications.map((v) => `<div class="timeline-step done"><div class="timeline-dot">•</div>
      <div><strong>${escapeHtml(v.action)}</strong><div class="tiny muted">${escapeHtml(v.actor)} · ${formatDate(v.createdAt)} · ${v.amount}</div>
      <div class="tiny">${escapeHtml(v.evidence || v.note || '')}</div></div></div>`).join('') || '<div class="tiny muted">ยังไม่มีบันทึกการตรวจสอบ</div>'}</div>
    ${detail.envelope.length ? `<p class="tiny muted">ซอง: ${escapeHtml(detail.envelope[0].voucherCode)} · ${detail.envelope[0].amount} · ${detail.envelope[0].status} (${detail.envelope[0].source})</p>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" data-tm-close>ปิด</button>
      ${canAct ? `<button class="btn btn-ghost" data-tm-reverify>เริ่มตรวจสอบ</button>
      <button class="btn btn-danger" data-tm-reject>ปฏิเสธ</button>
      <button class="btn btn-primary" data-tm-approve>ยืนยันยอดและอนุมัติ</button>` : ''}
    </div>
  </div>`;
  document.getElementById('modal-root').appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector('[data-tm-close]').addEventListener('click', close);
  if (!canAct) return;

  const send = async (action) => {
    const amountValue = modal.querySelector('[data-tm-amount]').value;
    const payload = {
      action,
      amount: amountValue === '' ? undefined : Number(amountValue),
      evidence: modal.querySelector('[data-tm-evidence]').value,
      note: modal.querySelector('[data-tm-note]').value,
    };
    try {
      const res = await api(`/admin/topups/${t.id}/review`, { method: 'POST', body: payload });
      toast(res.message || 'บันทึกผลการตรวจสอบแล้ว', 'success', 8000);
      close();
      await envelopeTab(body, 'status=all');
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  };
  modal.querySelector('[data-tm-approve]').addEventListener('click', () => send('approve'));
  modal.querySelector('[data-tm-reject]').addEventListener('click', () => send('reject'));
  modal.querySelector('[data-tm-reverify]').addEventListener('click', () => send('reverify'));
}

const RENDERERS = {
  envelope: envelopeTab,
  analytics: analyticsTab,
  orders: ordersTab,
  referral: referralTab,
  email: emailTab,
  fraud: fraudTab,
  status: statusTab,
  roles: rolesTab,
};

export function isUltimateTab(tab) {
  return Boolean(RENDERERS[tab]);
}

export async function renderUltimateTab(tab, body) {
  const required = TAB_PERMISSION[tab];
  const granted = await perms();
  if (required && !granted.has(required)) {
    body.innerHTML = `<div class="card center"><p class="muted">คุณไม่มีสิทธิ์เข้าถึงส่วนนี้ (${escapeHtml(required)})</p></div>`;
    return;
  }
  await RENDERERS[tab](body);
}
