/**
 * VEXIS ULTIMATE — หน้าฝั่งสมาชิก: Referral · Wishlist · Order Tracking · System Status
 * ข้อมูลทั้งหมดมาจาก API จริง ไมมีข้อมูลจำลอง
 */
import { api, money, escapeHtml, toast, openModal, confirmModal, statusPill, formatDate } from './api.js?v=19';
import { t } from './i18n.js?v=18';

function card(content, title = '') {
  return `<div class="card">${title ? `<h3 class="card-title">${escapeHtml(title)}</h3>` : ''}${content}</div>`;
}

function skeleton(rows = 3) {
  return `<div class="stack">${Array.from({ length: rows })
    .map(() => '<div class="card"><div class="loader" style="min-height:60px"><div class="spinner"></div></div></div>')
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */

export async function renderWallet(ctx) {
  const { setPage, setRoute, state, loader, errorState } = ctx;
  setRoute('wallet');
  if (!state.me) {
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let data;
  try {
    data = await api('/wallet');
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }

  const rows = data.transactions.length
    ? data.transactions
        .map(
          (tx) => `<tr>
            <td class="t-nowrap">${formatDate(tx.createdAt)}</td>
            <td>${escapeHtml(tx.kindLabel)}${tx.refId ? `<div class="tiny muted">#${tx.refId}</div>` : ''}</td>
            <td class="tiny muted">${escapeHtml(tx.note || '')}</td>
            <td class="t-right" style="color:${tx.direction === 'out' ? '#ffb3bd' : '#7ff0b5'};font-weight:700">
              ${tx.direction === 'out' ? '-' : '+'}${tx.amount}
            </td>
            <td class="t-right tiny muted">${tx.balanceBefore} → ${tx.balanceAfter}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="5"><div class="empty-state">ยังไม่มีธุรกรรมในกระเป๋า</div></td></tr>`;

  setPage(`
    <div class="page">
      <div class="section-head">
        <div>
          <span class="eyebrow">WALLET</span>
          <h2 class="page-title">กระเป๋าเงิน</h2>
          <p>ทุกธุรกรรมถูกบันทึกพร้อมยอดก่อน/หลัง — แก้ไขยอดเองไม่ได้</p>
        </div>
        <a class="btn btn-primary btn-sm" href="#/topup">เติมเงิน</a>
      </div>

      <div class="stat-grid">
        <div class="stat-card highlight"><div class="label">เครดิตคงเหลือ</div><div class="value">${data.balance}</div><div class="hint">ใช้ซื้อคีย์ได้ทันที</div></div>
        <div class="stat-card"><div class="label">เติมเงินสะสม</div><div class="value">${data.summary.topupTotal}</div><div class="hint">${data.summary.transactions} ธุรกรรม</div></div>
        <div class="stat-card"><div class="label">ใช้จ่ายสะสม</div><div class="value">${data.summary.spendTotal}</div><div class="hint">ซื้อคีย์</div></div>
        <div class="stat-card"><div class="label">รอตรวจสอบ</div><div class="value">${data.summary.pendingCount}</div><div class="hint">ยอดแจ้ง ${data.summary.pendingAmount}</div></div>
      </div>

      <div class="card section" style="margin-top:16px">
        <h3 class="card-title">Wallet Transaction History</h3>
        <div class="table-wrap" style="margin-top:12px">
          <table><thead><tr><th>เวลา</th><th>ประเภท</th><th>รายละเอียด</th><th class="t-right">จำนวน</th><th class="t-right">ยอดคงเหลือ</th></tr></thead>
          <tbody>${rows}</tbody></table>
        </div>
      </div>
    </div>
  `);
}

/* ------------------------------------------------------------------ */
/* Referral                                                            */
/* ------------------------------------------------------------------ */

export async function renderReferral(ctx) {
  const { setPage, setRoute, state, loader, errorState } = ctx;
  setRoute('referral');
  if (!state.me) {
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let data;
  try {
    data = await api('/referral');
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }

  const stats = data.stats;
  const campaign = data.campaign;
  const history = stats.history.length
    ? stats.history
        .map(
          (row) => `<tr>
            <td class="t-nowrap">${formatDate(row.createdAt)}</td>
            <td>${row.kind === 'signup' ? 'เพื่อนสมัคร' : 'เพื่อนซื้อครั้งแรก'}</td>
            <td>${escapeHtml(row.username || '-')}</td>
            <td class="t-right">${row.rewardType === 'point' ? `${row.amount} แต้ม` : money(row.amount)}</td>
            <td><span class="pill pill-approved">${row.status === 'credited' ? 'ได้รับแล้ว' : escapeHtml(row.status)}</span></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="5"><div class="empty-state">${t('common.none')}</div></td></tr>`;

  const campaignBox = campaign.active
    ? `<div class="kv"><span>แคมเปญ</span><span>${escapeHtml(campaign.name)}</span></div>
       <div class="kv"><span>${t('referral.signupReward')}</span><span>${campaign.rewardType === 'point' ? `${campaign.signupReward} แต้ม` : campaign.signupReward}</span></div>
       <div class="kv"><span>${t('referral.purchaseReward')}</span><span>${campaign.rewardType === 'point' ? `${campaign.purchaseReward} แต้ม` : campaign.purchaseReward}</span></div>
       <div class="kv"><span>${t('referral.maxRewards')}</span><span>${campaign.maxRewards || 'ไม่จำกัด'}</span></div>
       <div class="kv"><span>${t('referral.period')}</span><span>${escapeHtml(campaign.startsAt || 'ไม่กำหนด')} → ${escapeHtml(campaign.endsAt || 'ไม่กำหนด')}</span></div>`
    : `<div class="empty-state">${t('referral.closed')}${campaign.reason ? ` — ${escapeHtml(campaign.reason)}` : ''}</div>`;

  setPage(`
    <div class="page">
      <div class="section-head"><div>
        <h2 class="page-title">${t('referral.title')}</h2>
        <p>${t('referral.subtitle')}</p>
      </div></div>

      <div class="stat-grid">
        <div class="stat-card highlight"><div class="label">${t('referral.earned')}</div><div class="value">${money(stats.earned)}</div><div class="hint">${stats.signups} รางวัลจากการสมัคร</div></div>
        <div class="stat-card"><div class="label">${t('referral.signups')}</div><div class="value">${stats.signups}</div><div class="hint">นับเฉพาะที่ยืนยันในระบบ</div></div>
        <div class="stat-card"><div class="label">${t('referral.friends')}</div><div class="value">${stats.friends}</div><div class="hint">เพื่อนที่สมัครผ่านคุณ</div></div>
      </div>

      <div class="two-col" style="margin-top:18px">
        <div class="card">
          <h3 class="card-title">${t('referral.code')}</h3>
          <div class="referral-code">${escapeHtml(data.code)}</div>
          <p class="tiny muted" style="margin-top:8px">${t('referral.link')}</p>
          <div class="copy-row">
            <input class="input" readonly value="${escapeHtml(data.link)}" data-referral-link />
            <button class="btn btn-primary btn-sm" data-copy="${escapeHtml(data.link)}">${t('common.copy')}</button>
          </div>
        </div>
        <div class="card">
          <h3 class="card-title">${t('referral.campaign')}</h3>
          <div style="margin-top:10px">${campaignBox}</div>
        </div>
      </div>

      <div class="card section" style="margin-top:18px">
        <h3 class="card-title">${t('referral.history')}</h3>
        <div class="table-wrap" style="margin-top:12px">
          <table><thead><tr><th>วันที่</th><th>ประเภท</th><th>ผู้ใช้</th><th class="t-right">รางวัล</th><th>สถานะ</th></tr></thead>
          <tbody>${history}</tbody></table>
        </div>
      </div>
    </div>
  `);
}

/* ------------------------------------------------------------------ */
/* Wishlist                                                            */
/* ------------------------------------------------------------------ */

export async function renderWishlist(ctx) {
  const { setPage, setRoute, state, loader, errorState } = ctx;
  setRoute('wishlist');
  if (!state.me) {
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let data;
  try {
    data = await api('/wishlist');
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }

  const rows = data.items.length
    ? data.items
        .map(
          (item) => `<div class="wishlist-row" data-wishlist-item="${item.productId}">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              <div class="tiny muted">${escapeHtml(item.category)} · เพิ่มเมื่อ ${formatDate(item.addedAt)}</div>
              <div class="tiny" style="margin-top:4px">
                ${item.inStock ? `<span class="pill pill-approved">${t('wishlist.inStock')} ${item.stock}</span>` : `<span class="pill pill-rejected">${t('wishlist.outStock')}</span>`}
                ${item.priceChanged ? `<span class="pill pill-pending">${t('wishlist.priceChanged')} (${item.priceAtAdd} → ${item.price})</span>` : ''}
              </div>
            </div>
            <div class="wishlist-actions">
              <strong>${item.price}</strong>
              <button class="btn btn-sm btn-primary" data-wishlist-buy="${item.productId}" ${item.inStock ? '' : 'disabled'}>${t('common.buy')}</button>
              <button class="btn btn-sm btn-ghost" data-wishlist-remove="${item.productId}">${t('wishlist.remove')}</button>
            </div>
          </div>`,
        )
        .join('')
    : `<div class="empty-state">${t('wishlist.empty')}</div>`;

  setPage(`
    <div class="page">
      <div class="section-head"><div>
        <h2 class="page-title">${t('wishlist.title')}</h2>
        <p>${t('wishlist.subtitle')}</p>
      </div></div>
      <div class="card">${rows}</div>
      <p class="tiny muted" style="margin-top:10px">แจ้งเตือนเมื่อกลับมามีสต็อก/ราคาเปลี่ยน แสดงเป็นป้ายบนรายการนี้ทุกครั้งที่เปิดหน้า (ข้อมูลสดจากฐานข้อมูล)</p>
    </div>
  `);

  document.querySelectorAll('[data-wishlist-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.wishlistRemove;
      btn.disabled = true;
      try {
        await api(`/wishlist/${id}`, { method: 'DELETE' });
        toast('ลบออกจากรายการที่สนใจแล้ว', 'success');
        await renderWishlist(ctx);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-wishlist-buy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const productId = Number(btn.dataset.wishlistBuy);
      const item = data.items.find((row) => row.productId === productId);
      const ok = await confirmModal({
        title: 'ยืนยันการซื้อ',
        message: `ซื้อ ${item.name} ราคา ${item.price} ด้วยเครดิตในกระเป๋า?`,
        confirmText: t('common.buy'),
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        const res = await api('/orders', {
          method: 'POST',
          body: { productId, quantity: 1, clientToken: `wish-${productId}-${Date.now()}` },
        });
        openModal(`
          <h3>ซื้อสำเร็จ</h3>
          <p class="modal-sub">${escapeHtml(res.order.productName)} · ${money(res.order.total)}</p>
          <pre class="key-box">${escapeHtml(res.order.codes.join('\n'))}</pre>
          <div class="modal-actions"><button class="btn btn-primary" onclick="document.getElementById('modal-root').innerHTML=''">${t('common.close')}</button></div>
        `);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Order tracking                                                      */
/* ------------------------------------------------------------------ */

async function openTimeline(orderId) {
  const modal = openModal(`<div class="loader"><div class="spinner"></div></div>`);
  try {
    const data = await api(`/orders/${orderId}/timeline`);
    const steps = data.steps
      .map(
        (step, index) => `<div class="timeline-step ${step.done ? 'done' : ''}">
          <div class="timeline-dot">${step.done ? '✓' : index + 1}</div>
          <div>
            <strong>${escapeHtml(step.title)}</strong>
            <div class="tiny muted">${escapeHtml(step.label)}${step.note ? ` — ${escapeHtml(step.note)}` : ''}</div>
            <div class="tiny" style="color:#9aa0b4">${step.at ? formatDate(step.at) : 'รอดำเนินการ'}</div>
          </div>
        </div>`,
      )
      .join('');
    const codes = data.codes.length ? `<pre class="key-box">${escapeHtml(data.codes.join('\n'))}</pre>` : '';
    modal.overlay.querySelector('.modal').innerHTML = `
      <h3>${t('orders.orderId')} #${data.order.id}</h3>
      <p class="modal-sub">${escapeHtml(data.order.productName)} · ${data.order.quantity} ชิ้น · ${data.order.total}</p>
      <div class="kv"><span>${t('orders.payment')}</span><span>${statusPill(data.order.paymentStatus)}</span></div>
      <div class="kv"><span>${t('orders.delivery')}</span><span>${statusPill(data.order.deliveryStatus)}</span></div>
      ${data.order.couponCode ? `<div class="kv"><span>คูปอง</span><span>${escapeHtml(data.order.couponCode)} (−${data.order.discount})</span></div>` : ''}
      <div class="timeline">${steps}</div>
      ${codes}
      <div class="modal-actions"><button class="btn btn-ghost" data-timeline-close>${t('common.close')}</button></div>
    `;
    modal.overlay.querySelector('[data-timeline-close]').addEventListener('click', modal.close);
  } catch (err) {
    modal.overlay.querySelector('.modal').innerHTML = `<h3>เกิดข้อผิดพลาด</h3><p class="modal-sub">${escapeHtml(err.message)}</p>
      <div class="modal-actions"><button class="btn btn-ghost" data-timeline-close>${t('common.close')}</button></div>`;
    modal.overlay.querySelector('[data-timeline-close]').addEventListener('click', modal.close);
  }
}

export async function renderOrders(ctx) {
  const { setPage, setRoute, state, loader, errorState } = ctx;
  setRoute('orders');
  if (!state.me) {
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let data;
  try {
    data = await api('/orders');
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }
  const rows = data.orders.length
    ? data.orders
        .map(
          (order) => `<tr>
            <td class="t-nowrap">#${order.id}</td>
            <td>${escapeHtml(order.productName)}</td>
            <td class="t-right">${order.quantity}</td>
            <td class="t-right">${money(order.total)}</td>
            <td>${statusPill(order.status)}</td>
            <td class="t-nowrap">${formatDate(order.createdAt)}</td>
            <td><button class="btn btn-sm btn-ghost" data-timeline="${order.id}">${t('orders.timeline')}</button></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="7"><div class="empty-state">${t('common.none')}</div></td></tr>`;

  setPage(`
    <div class="page">
      <div class="section-head"><div>
        <h2 class="page-title">${t('orders.title')}</h2>
        <p>${t('orders.subtitle')}</p>
      </div></div>
      <div class="card">
        <div class="table-wrap">
          <table><thead><tr><th>${t('orders.orderId')}</th><th>สินค้า</th><th class="t-right">จำนวน</th><th class="t-right">ยอดรวม</th><th>สถานะ</th><th>วันที่</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table>
        </div>
      </div>
    </div>
  `);

  document.querySelectorAll('[data-timeline]').forEach((btn) => {
    btn.addEventListener('click', () => openTimeline(btn.dataset.timeline));
  });
}

/* ------------------------------------------------------------------ */
/* System status (public)                                              */
/* ------------------------------------------------------------------ */

const STATUS_CLASS = {
  operational: 'pill-approved',
  degraded: 'pill-pending',
  partial_outage: 'pill-pending',
  major_outage: 'pill-rejected',
  maintenance: 'pill-pending',
  unknown: 'pill-open',
};

const STATUS_TH = {
  operational: 'ทำงานปกติ',
  degraded: 'ทำงานช้าลง',
  partial_outage: 'ทำงานบางส่วน',
  major_outage: 'ขัดข้อง',
  maintenance: 'ปิดปรับปรุง',
  unknown: 'ตรวจสอบไม่ได้',
};

export async function renderStatus(ctx) {
  const { setPage, setRoute, loader, errorState } = ctx;
  setRoute('status');
  setPage(loader());
  let data;
  try {
    data = await fetch('/api/status', { headers: { accept: 'application/json' } }).then((res) => res.json());
  } catch (err) {
    setPage(errorState('โหลดสถานะระบบไม่สำเร็จ'));
    return;
  }

  const services = (data.services || [])
    .map(
      (svc) => `<div class="list-row">
        <div><strong>${escapeHtml(svc.label)}</strong>${svc.detail ? `<div class="tiny muted">${escapeHtml(svc.detail)}</div>` : ''}</div>
        <div class="row" style="gap:10px">
          <span class="tiny muted">${svc.latency ? `${svc.latency} ms` : ''}</span>
          <span class="pill ${STATUS_CLASS[svc.status] || 'pill-open'}">${STATUS_TH[svc.status] || svc.status}</span>
        </div>
      </div>`,
    )
    .join('');

  const incidents = (data.incidents || []).length
    ? data.incidents
        .map(
          (incident) => `<div class="list-row" style="align-items:flex-start">
            <div>
              <strong>${escapeHtml(incident.title)}</strong>
              <div class="tiny muted">เริ่ม ${formatDate(incident.startedAt)}${incident.endedAt ? ` · สิ้นสุด ${formatDate(incident.endedAt)}` : ''}</div>
              ${incident.body ? `<div class="small" style="margin-top:4px">${escapeHtml(incident.body)}</div>` : ''}
            </div>
            <span class="pill ${incident.status === 'resolved' ? 'pill-approved' : 'pill-pending'}">${incident.status}</span>
          </div>`,
        )
        .join('')
    : `<div class="empty-state">${t('status.noIncidents')}</div>`;

  setPage(`
    <div class="page">
      <div class="section-head"><div>
        <h2 class="page-title">${t('status.title')}</h2>
        <p>${t('status.subtitle')}</p>
      </div></div>

      ${
        data.maintenance
          ? `<div class="card" style="border-color:rgba(255,196,102,.35);background:rgba(255,196,102,.06)">
               <strong>ปิดปรับปรุงชั่วคราว</strong>
               <p class="small" style="margin-top:6px">${escapeHtml(data.maintenanceMessage || 'ร้านกำลังปิดปรับปรุงระบบ')}</p>
             </div>`
          : ''
      }

      <div class="card" style="margin-top:14px">
        <div class="row between wrap">
          <div>
            <h3 class="card-title">${t('status.overall')}</h3>
            <div class="tiny muted">${t('status.updated')} ${new Date(data.updatedAt).toLocaleString('th-TH')}</div>
          </div>
          <span class="pill ${STATUS_CLASS[data.overall] || 'pill-open'}">${STATUS_TH[data.overall] || data.overall}</span>
        </div>
        <div style="margin-top:12px">${services}</div>
      </div>

      <div class="card section" style="margin-top:14px">
        <h3 class="card-title">${t('status.incidents')}</h3>
        <div style="margin-top:10px">${incidents}</div>
      </div>
      <p class="tiny muted" style="margin-top:10px">สถานะที่แสดงคือผลตรวจจากเซิร์ฟเวอร์และฐานข้อมูลจริง ไม่ใช่ค่าที่ตั้งไว้ล่วงหน้า — บริการที่ไม่สามารถตรวจสอบได้จะแสดง "ตรวจสอบไม่ได้"</p>
    </div>
  `);
}
