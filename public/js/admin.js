import {
  api,
  money,
  escapeHtml,
  toast,
  openModal,
  confirmModal,
  statusPill,
  roleBadge,
  formatDate,
} from './api.js?v=8';

const TABS = [
  ['overview', 'ภาพรวม'],
  ['topups', 'เติมเงิน'],
  ['coupons', 'คูปอง'],
  ['products', 'สินค้า & สต็อก'],
  ['categories', 'หมวดหมู่'],
  ['users', 'ผู้ใช้ & ยศ'],
  ['resellers', 'ตัวแทน & API'],
  ['tickets', 'ซัพพอร์ต'],
  ['settings', 'ตั้งค่าธรรมเนียม/บัญชี'],
  ['logs', 'ประวัติการใช้งาน'],
];

function parseTab() {
  const raw = location.hash.split('?')[1] || '';
  const params = new URLSearchParams(raw);
  const tab = params.get('tab') || 'overview';
  return TABS.some(([key]) => key === tab) ? tab : 'overview';
}

let activeCtx = null;
let activeTab = 'overview';

/* โหลดเฉพาะเนื้อหาแท็บ ไม่สร้างหน้าใหม่ทั้งหน้า → ไม่รีหน้า/ไม่กระพริบ */
async function refreshTab() {
  if (!activeCtx) return;
  await loadTab(activeTab, activeCtx);
}

function goTab(tab) {
  const next = `#/admin?tab=${tab}`;
  if (location.hash !== next) history.replaceState(null, '', next);
  if (activeCtx) loadTab(tab, activeCtx);
}

function spinner() {
  return `<div class="loader"><div class="spinner"></div></div>`;
}

function errorCard(message) {
  return `<div class="card center"><p class="muted">${escapeHtml(message)}</p></div>`;
}

/* ------------------------------------------------------------------ */
/* overview                                                            */
/* ------------------------------------------------------------------ */

async function overviewTab(body, ctx, silent = false) {
  if (!silent) body.innerHTML = spinner();
  const data = await api('/admin/overview');
  const roleRows = ['owner', 'admin', 'dealer', 'member']
    .map(
      (key) => `<div class="kv"><span>${roleBadge(key, key === 'dealer' ? 'ตัวแทน/ตัวขาย' : key)}</span><span>${data.roles[key] || 0} คน</span></div>`,
    )
    .join('');

  const lowStock = data.lowStock.length
    ? data.lowStock
        .map(
          (p) => `<div class="list-row"><span>${escapeHtml(p.name)}</span>
        <span style="color:${p.stock === 0 ? '#ff8d9b' : '#ffcf8a'}">${p.stock} ชิ้น</span></div>`,
        )
        .join('')
    : `<div class="empty-state">สต็อกทุกรายการเพียงพอ</div>`;

  const recentOrders = data.recentOrders.length
    ? data.recentOrders
        .map(
          (o) => `<tr><td class="t-nowrap">${formatDate(o.created_at)}</td><td>${escapeHtml(o.username)}</td>
        <td>${escapeHtml(o.product_name)}</td><td class="t-right">${money(o.total)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="4"><div class="empty-state">ยังไม่มีคำสั่งซื้อ</div></td></tr>`;

  const recentTopups = data.recentTopups.length
    ? data.recentTopups
        .map(
          (t) => `<tr><td class="t-nowrap">${formatDate(t.created_at)}</td><td>${escapeHtml(t.username)}</td>
        <td>${t.method === 'envelope' ? 'ซองทรู' : 'ธนาคาร'}</td>
        <td class="t-right">${money(t.amount)}</td><td class="t-right" style="color:#7ff0b5">${money(t.net)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="5"><div class="empty-state">ยังไม่มีรายการเติมเงิน</div></td></tr>`;

  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card highlight"><div class="label">ยอดขายรวม</div><div class="value">${money(data.revenue)}</div><div class="hint">${data.orderCount} คำสั่งซื้อ</div></div>
      <div class="stat-card"><div class="label">รอตรวจสอบการเติมเงิน</div><div class="value">${data.pendingTopups.count}</div><div class="hint">ยอดแจ้ง ${money(data.pendingTopups.amount)}</div></div>
      <div class="stat-card"><div class="label">สมาชิกทั้งหมด</div><div class="value">${data.userCount}</div><div class="hint">ทุกยศรวมกัน</div></div>
      <div class="stat-card"><div class="label">ค่าธรรมเนียมระบบ</div><div class="value">${data.feePercent}%</div><div class="hint">หักจากยอดเติมเงิน</div></div>
      <div class="stat-card"><div class="label">การป้องกัน DDoS</div><div class="value">${data.security ? data.security.activeBans : 0}</div><div class="hint">IP ที่ถูกระงับอยู่ · แบนวันนี้ ${data.security ? data.security.bans24h : 0} ครั้ง</div></div>
    </div>

    <div class="two-col" style="margin-top:18px">
      <div class="card">
        <h3 class="card-title">คำสั่งซื้อล่าสุด</h3>
        <div class="table-wrap" style="margin-top:12px">
          <table><thead><tr><th>วันที่</th><th>ผู้ซื้อ</th><th>สินค้า</th><th class="t-right">ยอด</th></tr></thead>
          <tbody>${recentOrders}</tbody></table>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <h3 class="card-title">สต็อกใกล้หมด</h3>
          <div style="margin-top:8px">${lowStock}</div>
        </div>
        <div class="card">
          <h3 class="card-title">จำนวนสมาชิกตามยศ</h3>
          <div style="margin-top:8px">${roleRows}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="card">
        <h3 class="card-title">เติมเงินล่าสุด</h3>
        <div class="table-wrap" style="margin-top:12px">
          <table><thead><tr><th>วันที่</th><th>ผู้ใช้</th><th>ช่องทาง</th><th class="t-right">ยอดแจ้ง</th><th class="t-right">รับจริง (หลังหัก)</th></tr></thead>
          <tbody>${recentTopups}</tbody></table>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* top-ups                                                             */
/* ------------------------------------------------------------------ */

async function topupsTab(body, ctx) {
  let filter = 'pending';
  body.innerHTML = `
    <div class="section-head" style="margin-bottom:12px">
      <div><h3 class="card-title-lg">ตรวจสอบการเติมเงิน</h3>
      <p class="small muted">อนุมัติแล้วระบบจะหักค่าธรรมเนียม ${ctx.state.config.feePercent}% และเติมเครดิตตามยอดสุทธิ</p></div>
      <div class="chips" id="topup-filter">
        ${[['pending', 'รอตรวจสอบ'], ['approved', 'อนุมัติแล้ว'], ['rejected', 'ปฏิเสธ'], ['all', 'ทั้งหมด']]
          .map(([key, label]) => `<button class="chip ${key === 'pending' ? 'active' : ''}" data-filter="${key}">${label}</button>`)
          .join('')}
      </div>
    </div>
    <div id="topup-list">${spinner()}</div>`;

  const list = document.getElementById('topup-list');

  const load = async () => {
    list.innerHTML = spinner();
    try {
      const data = await api(`/admin/topups?status=${filter}`);
      if (!data.topups.length) {
        list.innerHTML = `<div class="card"><div class="empty-state">ไม่มีรายการในสถานะนี้</div></div>`;
        return;
      }
      list.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>วันที่</th><th>ผู้ใช้</th><th>ช่องทาง</th><th class="t-right">ยอดแจ้ง</th><th class="t-right">หัก ${data.feePercent}%</th><th class="t-right">รับจริง</th><th>อ้างอิง</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>${data.topups
          .map(
            (t) => `<tr>
              <td class="t-nowrap">${formatDate(t.createdAt)}</td>
              <td>${escapeHtml(t.username)}</td>
              <td>${t.method === 'envelope' ? 'ซองทรู' : 'ธนาคาร'}</td>
              <td class="t-right">${money(t.amount)}</td>
              <td class="t-right" style="color:#ffb3bd">-${money(t.fee)}</td>
              <td class="t-right" style="color:#7ff0b5;font-weight:700">${money(t.net)}</td>
              <td class="tiny mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(t.reference)}">${escapeHtml(t.reference)}</td>
              <td>${statusPill(t.status)}</td>
              <td>${
                t.status === 'pending'
                  ? `<div class="row-actions">
                       <button class="btn btn-sm btn-ok" data-approve="${t.id}">อนุมัติ</button>
                       <button class="btn btn-sm btn-danger" data-reject="${t.id}">ปฏิเสธ</button>
                     </div>`
                  : ''
              }</td>
            </tr>`,
          )
          .join('')}</tbody></table></div>`;

      list.querySelectorAll('[data-approve]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const item = data.topups.find((t) => t.id === Number(btn.dataset.approve));
          const ok = await confirmModal({
            title: 'ยืนยันรับเงินและเติมเครดิต',
            message: `รับเงิน ${money(item.amount)} · หัก ${data.feePercent}% (${money(item.fee)}) · เติมจริง ${money(item.net)} ให้ ${item.username}`,
            confirmText: 'อนุมัติและเติมเครดิต',
          });
          if (!ok) return;
          try {
            const res = await api(`/admin/topups/${item.id}/review`, {
              method: 'POST',
              body: { action: 'approve' },
            });
            toast(res.message, 'success', 6500);
            await load();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });

      list.querySelectorAll('[data-reject]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = data.topups.find((t) => t.id === Number(btn.dataset.reject));
          const modal = openModal(`
            <h3>ปฏิเสธรายการเติมเงิน</h3>
            <p class="modal-sub">${escapeHtml(item.username)} · ${money(item.amount)}</p>
            <div class="field"><label>เหตุผล (ไม่บังคับ)</label>
              <textarea class="textarea" data-reason maxlength="200" placeholder="เช่น ไม่พบรายการโอน / ลิงก์ซองไม่ถูกต้อง"></textarea>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" data-cancel>ยกเลิก</button>
              <button class="btn btn-danger" data-confirm>ยืนยันปฏิเสธ</button>
            </div>`);
          modal.overlay.querySelector('[data-cancel]').addEventListener('click', modal.close);
          modal.overlay.querySelector('[data-confirm]').addEventListener('click', async () => {
            try {
              await api(`/admin/topups/${item.id}/review`, {
                method: 'POST',
                body: { action: 'reject', note: modal.overlay.querySelector('[data-reason]').value.trim() },
              });
              modal.close();
              toast('ปฏิเสธรายการแล้ว', 'info');
              await load();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="card"><p class="muted">${escapeHtml(err.message)}</p></div>`;
    }
  };

  body.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      body.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      load();
    });
  });

  await load();
}

/* ------------------------------------------------------------------ */
/* products                                                            */
/* ------------------------------------------------------------------ */

function productModal(categories, product) {
  const isEdit = Boolean(product);
  const modal = openModal(`
    <h3>${isEdit ? 'แก้ไขสินค้า' : 'เพิ่มสินค้าใหม่'}</h3>
    <p class="modal-sub">${isEdit ? 'แก้ไขราคา สต็อก และหมวดหมู่' : 'เพิ่มสินค้าพร้อมสต็อกเข้าร้านทันที'}</p>
    <div class="stack">
      <div class="field"><label>ชื่อสินค้า</label>
        <input class="input" name="name" maxlength="80" value="${isEdit ? escapeHtml(product.name) : ''}" placeholder="เช่น PHANTOM KEY" /></div>
      <div class="field"><label>หมวดหมู่</label>
        <select class="select" name="categoryId">
          ${categories
            .map(
              (c) =>
                `<option value="${c.id}" ${isEdit && product.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`,
            )
            .join('')}
        </select></div>
      <div class="row" style="gap:10px">
        <div class="field" style="flex:1"><label>ราคาขาย (บาท)</label>
          <input class="input" name="price" type="number" min="1" max="100000" step="0.01" value="${isEdit ? product.price : ''}" /></div>
        <div class="field" style="flex:1"><label>ระยะเวลาการใช้งาน</label>
          <input class="input" name="duration" maxlength="40" value="${isEdit ? escapeHtml(product.duration || '') : '30 วัน'}" placeholder="เช่น 30 วัน" /></div>
      </div>
      <p class="tiny muted">สต็อกนับจากคีย์ในคลังเท่านั้น — หลังบันทึกสินค้าให้กด “จัดการคีย์” เพื่อเติมคีย์เข้าสต็อก</p>
      <div class="field"><label>รายละเอียด</label>
        <textarea class="textarea" name="description" maxlength="300">${isEdit ? escapeHtml(product.description) : ''}</textarea></div>
      <label class="checkbox-row"><input type="checkbox" name="active" ${!isEdit || product.active ? 'checked' : ''} /> แสดงสินค้าในร้าน</label>
      <div class="form-error" data-error></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>ยกเลิก</button>
      <button class="btn btn-primary" data-save>${isEdit ? 'บันทึกการแก้ไข' : 'เพิ่มสินค้า'}</button>
    </div>`);

  modal.overlay.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const root = modal.overlay;
    const errorEl = root.querySelector('[data-error]');
    const payload = {
      name: root.querySelector('[name="name"]').value.trim(),
      categoryId: Number(root.querySelector('[name="categoryId"]').value),
      price: Number(root.querySelector('[name="price"]').value),
      duration: root.querySelector('[name="duration"]').value.trim(),
      description: root.querySelector('[name="description"]').value.trim(),
      active: root.querySelector('[name="active"]').checked,
    };
    errorEl.textContent = '';
    try {
      if (isEdit) await api(`/admin/products/${product.id}`, { method: 'PATCH', body: payload });
      else await api('/admin/products', { method: 'POST', body: payload });
      modal.close();
      toast(isEdit ? 'บันทึกสินค้าแล้ว' : 'เพิ่มสินค้าแล้ว', 'success');
      goTab('products');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

async function productsTab(body, ctx) {
  body.innerHTML = spinner();
  const [prodRes, catRes] = await Promise.all([api('/admin/products'), api('/admin/categories')]);
  const categories = catRes.categories;
  const products = prodRes.products;

  body.innerHTML = `
    <div class="section-head" style="margin-bottom:12px">
      <div><h3 class="card-title-lg">สินค้าและสต็อก</h3>
        <p class="small muted">เพิ่ม/แก้ไขสินค้า ตั้งราคาขาย และเติมสต็อกได้ทันที</p></div>
      <button class="btn btn-primary btn-sm" data-add-product>+ เพิ่มสินค้า</button>
    </div>
    ${
      products.some((p) => p.needsKeys)
        ? `<div class="warn-banner" style="margin-bottom:12px">⚠ มี ${products.filter((p) => p.needsKeys).length} สินค้าที่ยังไม่มีคีย์จริง ลูกค้าซื้อไม่ได้ — กด “จัดการคีย์” แล้วใส่คีย์จริงก่อนเปิดขาย</div>`
        : ''
    }
    <div class="table-wrap"><table>
      <thead><tr><th>สินค้า</th><th>หมวดหมู่</th><th class="t-right">ราคาขาย</th><th class="t-right">ราคาตัวแทน</th><th>คีย์พร้อมขาย</th><th>สถานะ</th><th></th></tr></thead>
      <tbody>${
        products.length
          ? products
              .map(
                (p) => `<tr>
                  <td><strong>${escapeHtml(p.name)}</strong><div class="tiny muted">${escapeHtml(p.duration || '')}${p.duration ? ' · ' : ''}${escapeHtml(p.description || '')}</div></td>
                  <td>${escapeHtml(p.categoryName)}</td>
                  <td class="t-right">${money(p.price)}</td>
                  <td class="t-right muted">${money(p.dealerPrice)}</td>
                  <td><div class="inline-form">
                    <span class="stock-badge ${p.readyKeys === 0 ? 'out' : ''}">คีย์จริง <b>${p.readyKeys}</b></span>
                    <button class="btn btn-sm btn-ghost" data-keys="${p.id}">จัดการคีย์</button>
                  </div>
                  ${p.needsKeys ? '<div class="warn-banner tiny" style="margin-top:6px">⚠ ยังไม่มีคีย์จริง — ยังขายไม่ได้</div>' : ''}
                  ${p.demoKeys ? `<div class="tiny muted" style="margin-top:4px">มีคีย์ตัวอย่าง DEMO ${p.demoKeys} รายการ (กันไม่ให้ขาย)</div>` : ''}
                  </td>
                  <td>${p.active ? '<span class="pill pill-approved">ขายอยู่</span>' : '<span class="pill pill-rejected">ปิด</span>'}</td>
                  <td><div class="row-actions">
                    <button class="btn btn-sm btn-ghost" data-edit="${p.id}">แก้ไข</button>
                    <button class="btn btn-sm btn-danger" data-delete="${p.id}">ลบ</button>
                  </div></td>
                </tr>`,
              )
              .join('')
          : `<tr><td colspan="7"><div class="empty-state">ยังไม่มีสินค้า กด “เพิ่มสินค้า” เพื่อเริ่ม</div></td></tr>`
      }</tbody></table></div>`;

  body.querySelector('[data-add-product]').addEventListener('click', () => {
    if (!categories.length) return toast('เพิ่มหมวดหมู่ก่อน', 'error');
    productModal(categories, null);
  });

  products.forEach((p) => {
    const editBtn = body.querySelector(`[data-edit="${p.id}"]`);
    if (editBtn) editBtn.addEventListener('click', () => productModal(categories, p));

    const deleteBtn = body.querySelector(`[data-delete="${p.id}"]`);
    if (deleteBtn)
      deleteBtn.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: 'ลบสินค้า',
          message: `ต้องการลบ “${p.name}” ใช่หรือไม่`,
          confirmText: 'ลบสินค้า',
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`/admin/products/${p.id}`, { method: 'DELETE' });
          toast('ลบสินค้าแล้ว', 'info');
          goTab('products');
        } catch (err) {
          toast(err.message, 'error');
        }
      });

    const keysBtn = body.querySelector(`[data-keys="${p.id}"]`);
    if (keysBtn) keysBtn.addEventListener('click', () => keysModal(p));
  });
}

async function keysModal(product) {
  const modal = openModal(`
    <h3>คลังคีย์ — ${escapeHtml(product.name)}</h3>
    <p class="modal-sub">ระบบส่งคีย์ให้ลูกค้าอัตโนมัติทันทีหลังชำระเงิน และหักเครดิตอัตโนมัติ — คีย์ที่ขายแล้วจะไม่ถูกส่งซ้ำ</p>
    <div class="warn-banner" data-warn style="display:none">⚠ สินค้านี้ยังไม่มีคีย์จริง ลูกค้าซื้อไม่ได้ — วางคีย์จริงด้านล่างก่อนเปิดขาย (คีย์ตัวอย่าง DEMO ระบบกันไม่ให้ส่งขายแล้ว)</div>
    <div class="field"><label>เพิ่มคีย์ใหม่ (หนึ่งคีย์ต่อบรรทัด)</label>
      <textarea class="textarea" data-new-keys maxlength="20000" placeholder="FIFA-XXXX-XXXX\nFIFA-YYYY-YYYY"></textarea></div>
    <div class="form-error" data-error></div>
    <button class="btn btn-primary btn-block" data-add>เพิ่มเข้าคลัง</button>
    <div class="divider"></div>
    <div class="row between"><strong class="small">คีย์จริงพร้อมขาย</strong><span class="tiny muted" data-count>—</span></div>
    <div data-key-list class="key-list" style="margin-top:10px">${spinner()}</div>
    <div data-demo-box></div>
    <div class="modal-actions"><button class="btn btn-ghost" data-close>ปิด</button></div>
  `);

  const overlay = modal.overlay;
  const listEl = overlay.querySelector('[data-key-list]');
  const countEl = overlay.querySelector('[data-count]');
  const errorEl = overlay.querySelector('[data-error]');

  const demoBox = overlay.querySelector('[data-demo-box]');
  const warnBox = overlay.querySelector('[data-warn]');

  const load = async () => {
    try {
      const data = await api(`/admin/products/${product.id}/keys?status=available`);
      countEl.textContent = `พร้อมขาย ${data.available} คีย์จริง`;
      warnBox.style.display = data.available === 0 ? '' : 'none';
      listEl.innerHTML = data.keys.length
        ? data.keys
            .slice(0, 60)
            .map(
              (k) => `<div class="key-item"><code>${escapeHtml(k.code)}</code>
                <button class="btn btn-sm btn-danger" data-remove="${k.id}">ลบ</button></div>`,
            )
            .join('') +
          (data.keys.length > 60 ? `<div class="tiny muted">แสดง 60 รายการแรกจาก ${data.keys.length}</div>` : '')
        : '<div class="empty-state">ยังไม่มีคีย์จริง — วางคีย์ด้านบนแล้วกดเพิ่ม</div>';

      if (data.demo > 0) {
        demoBox.innerHTML = `<div class="row between wrap" style="gap:8px;margin-top:14px;align-items:center">
            <div>
              <strong class="small">คีย์ตัวอย่าง DEMO ${data.demo} รายการ</strong>
              <div class="tiny muted">ระบบกันไว้แล้ว ลูกค้าไม่ได้รับคีย์ชุดนี้ — ใส่คีย์จริงก่อนเปิดขาย</div>
            </div>
            <button class="btn btn-sm btn-danger" data-clear-demo>ลบคีย์ตัวอย่างทั้งหมด</button>
          </div>`;
        demoBox.querySelector('[data-clear-demo]').addEventListener('click', async (event) => {
          const ok = await confirmModal({
            title: 'ลบคีย์ตัวอย่าง',
            message: `ต้องการลบคีย์ตัวอย่าง DEMO ทั้ง ${data.demo} รายการของ “${product.name}” ใช่หรือไม่`,
            confirmText: 'ลบทั้งหมด',
            danger: true,
          });
          if (!ok) return;
          const btn = event.currentTarget;
          btn.disabled = true;
          try {
            const res = await api(`/admin/products/${product.id}/demo-keys`, { method: 'DELETE' });
            toast(`ลบคีย์ตัวอย่างแล้ว ${res.removed} รายการ`, 'info');
            await load();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        });
      } else {
        demoBox.innerHTML = '';
      }

      listEl.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api(`/admin/products/${product.id}/keys/${btn.dataset.remove}`, { method: 'DELETE' });
            toast('ลบคีย์แล้ว', 'info');
            await load();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = errorCard(err.message);
    }
  };

  overlay.querySelector('[data-add]').addEventListener('click', async () => {
    const textarea = overlay.querySelector('[data-new-keys]');
    const btn = overlay.querySelector('[data-add]');
    errorEl.textContent = '';
    if (!textarea.value.trim()) {
      errorEl.textContent = 'กรุณาวางคีย์ก่อนกดเพิ่ม';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก…';
    try {
      const res = await api(`/admin/products/${product.id}/keys`, {
        method: 'POST',
        body: { keys: textarea.value },
      });
      textarea.value = '';
      toast(res.message, 'success');
      await load();
    } catch (err) {
      errorEl.textContent = err.message;
    }
    btn.disabled = false;
    btn.textContent = 'เพิ่มเข้าคลัง';
  });

  overlay.querySelector('[data-close]').addEventListener('click', () => {
    modal.close();
    goTab('products');
  });

  await load();
}

/* ------------------------------------------------------------------ */
/* categories                                                          */
/* ------------------------------------------------------------------ */

async function categoriesTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/categories');
  const rows = data.categories.length
    ? data.categories
        .map(
          (c) => `<tr>
            <td><strong>${escapeHtml(c.name)}</strong><div class="tiny muted">${escapeHtml(c.description || '')}</div></td>
            <td class="t-right">${c.product_count}</td>
            <td class="t-right">${c.sort_order}</td>
            <td><div class="row-actions">
              <button class="btn btn-sm btn-ghost" data-rename="${c.id}">เปลี่ยนชื่อ</button>
              <button class="btn btn-sm btn-danger" data-del-cat="${c.id}">ลบ</button>
            </div></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="4"><div class="empty-state">ยังไม่มีหมวดหมู่</div></td></tr>`;

  body.innerHTML = `
    <div class="section-head" style="margin-bottom:12px">
      <div><h3 class="card-title-lg">หมวดหมู่สินค้า</h3><p class="small muted">จัดกลุ่มสินค้าให้ลูกค้าค้นหาง่าย</p></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <form data-form="category" class="inline-form">
        <input class="input" name="name" maxlength="40" placeholder="ชื่อหมวดหมู่ใหม่" required style="flex:1;min-width:180px" />
        <input class="input" name="description" maxlength="160" placeholder="คำอธิบาย (ไม่บังคับ)" style="flex:2;min-width:200px" />
        <input class="input" name="sortOrder" type="number" min="0" max="9999" value="100" style="width:90px" />
        <button class="btn btn-primary btn-sm" type="submit">เพิ่มหมวดหมู่</button>
      </form>
      <div class="form-error" data-error></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>หมวดหมู่</th><th class="t-right">สินค้า</th><th class="t-right">ลำดับ</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  const form = body.querySelector('[data-form="category"]');
  const errorEl = body.querySelector('[data-error]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    try {
      await api('/admin/categories', {
        method: 'POST',
        body: {
          name: form.name.value.trim(),
          description: form.description.value.trim(),
          sortOrder: Number(form.sortOrder.value) || 100,
        },
      });
      toast('เพิ่มหมวดหมู่แล้ว', 'success');
      goTab('categories');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  data.categories.forEach((c) => {
    body.querySelector(`[data-rename="${c.id}"]`).addEventListener('click', () => {
      const modal = openModal(`
        <h3>เปลี่ยนชื่อหมวดหมู่</h3>
        <p class="modal-sub">หมวดหมู่: ${escapeHtml(c.name)}</p>
        <div class="field"><label>ชื่อใหม่</label>
          <input class="input" data-name maxlength="40" value="${escapeHtml(c.name)}" /></div>
        <div class="form-error" data-error></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-cancel>ยกเลิก</button>
          <button class="btn btn-primary" data-save>บันทึก</button>
        </div>`);
      modal.overlay.querySelector('[data-cancel]').addEventListener('click', modal.close);
      modal.overlay.querySelector('[data-save]').addEventListener('click', async () => {
        const name = modal.overlay.querySelector('[data-name]').value.trim();
        if (name.length < 2) {
          modal.overlay.querySelector('[data-error]').textContent = 'ชื่อหมวดหมู่ต้องมีอย่างน้อย 2 ตัวอักษร';
          return;
        }
        try {
          await api(`/admin/categories/${c.id}`, { method: 'PATCH', body: { name } });
          modal.close();
          toast('เปลี่ยนชื่อแล้ว', 'success');
          goTab('categories');
        } catch (err) {
          modal.overlay.querySelector('[data-error]').textContent = err.message;
        }
      });
    });
    body.querySelector(`[data-del-cat="${c.id}"]`).addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'ลบหมวดหมู่',
        message: `ลบ “${c.name}” (ต้องไม่มีสินค้าอยู่ในหมวดนี้)`,
        confirmText: 'ลบ',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/admin/categories/${c.id}`, { method: 'DELETE' });
        toast('ลบหมวดหมู่แล้ว', 'info');
        goTab('categories');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* users & roles                                                       */
/* ------------------------------------------------------------------ */

async function usersTab(body, ctx) {
  body.innerHTML = spinner();
  const data = await api('/admin/users');
  const isOwner = ctx.state.me.role === 'owner';
  const roleOptions = ['owner', 'admin', 'dealer', 'member'];

  const rows = data.users
    .map(
      (u) => `<tr>
        <td><strong>${escapeHtml(u.username)}</strong>${u.isRoot ? ' <span class="badge badge-owner">ROOT</span>' : ''}
          <div class="tiny muted">สมัคร ${formatDate(u.createdAt)}</div></td>
        <td>${roleBadge(u.role, u.roleLabel)}</td>
        <td class="t-right" style="color:#7ff0b5">${money(u.balance)}</td>
        <td class="t-right">${u.orderCount}</td>
        <td class="t-right">${money(u.spent)}</td>
        <td class="t-nowrap">${formatDate(u.lastLoginAt)}</td>
        <td>${
          isOwner && !u.isRoot && u.id !== ctx.state.me.id
            ? `<select class="role-select" data-role-user="${u.id}">
                 ${roleOptions
                   .map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`)
                   .join('')}
               </select>`
            : `<span class="tiny muted">${u.isRoot ? 'ล็อก (Owner สูงสุด)' : '-'}</span>`
        }</td>
      </tr>`,
    )
    .join('');

  body.innerHTML = `
    <div class="section-head" style="margin-bottom:12px">
      <div><h3 class="card-title-lg">ผู้ใช้และยศ</h3>
        <p class="small muted">${
          isOwner
            ? 'Owner สามารถให้ยศ 1-owner / 2-admin / 3-ตัวแทน / 4-member ได้'
            : 'เฉพาะ Owner เท่านั้นที่เปลี่ยนยศได้'
        }</p></div>
    </div>
    <div class="note-box" style="margin-bottom:14px">
      ยศ: <b>1-owner</b> จัดการทุกอย่างและให้ยศได้ · <b>2-admin</b> เพิ่มสต็อก/สินค้าและซัพพอร์ต ·
      <b>3-ตัวแทน/ตัวขาย</b> ซื้อคีย์ราคาลด ${ctx.state.config.dealerDiscount}% · <b>4-member</b> ซื้อของและเติมเงิน
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>ผู้ใช้</th><th>ยศ</th><th class="t-right">เครดิต</th><th class="t-right">ออเดอร์</th><th class="t-right">ยอดซื้อ</th><th>เข้าล่าสุด</th><th>เปลี่ยนยศ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  body.querySelectorAll('[data-role-user]').forEach((select) => {
    select.addEventListener('change', async () => {
      const userId = Number(select.dataset.roleUser);
      const user = data.users.find((u) => u.id === userId);
      const ok = await confirmModal({
        title: 'เปลี่ยนยศผู้ใช้',
        message: `เปลี่ยนยศของ ${user.username} เป็น ${select.value}?`,
        confirmText: 'เปลี่ยนยศ',
      });
      if (!ok) {
        select.value = user.role;
        return;
      }
      try {
        const res = await api(`/admin/users/${userId}/role`, {
          method: 'PATCH',
          body: { role: select.value },
        });
        toast(`${user.username} → ${res.roleLabel}`, 'success');
        goTab('users');
      } catch (err) {
        select.value = user.role;
        toast(err.message, 'error');
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* resellers / ตัวแทน & API                                            */
/* ------------------------------------------------------------------ */

async function resellersTab(body, ctx) {
  body.innerHTML = spinner();
  const data = await api('/admin/resellers');
  const rows = data.resellers.length
    ? data.resellers
        .map((r) => {
          const actions =
            r.status === 'pending'
              ? `<button class="btn btn-sm btn-ok" data-approve-reseller="${r.id}">อนุมัติ</button>
                 <button class="btn btn-sm btn-danger" data-reject-reseller="${r.id}">ไม่อนุมัติ</button>`
              : r.status === 'active' || r.status === 'suspended'
                ? `<button class="btn btn-sm btn-danger" data-revoke-reseller="${r.id}">ปลด</button>`
                : '<span class="tiny muted">-</span>';
          return `<tr>
            <td><strong>${escapeHtml(r.username)}</strong> ${roleBadge(r.role, r.roleLabel)}
              <div class="tiny muted">${escapeHtml(r.contact || '-')} · เครดิต ${money(r.balance)}</div>
              ${r.reviewNote ? `<div class="tiny" style="color:#ffcf8a;margin-top:2px">${escapeHtml(r.reviewNote)}</div>` : ''}
            </td>
            <td>${statusPill(r.status)}</td>
            <td class="t-right">${money(r.weekly)}<div class="tiny muted">เป้า ${money(data.weeklyTarget)}</div></td>
            <td class="t-right">${money(r.monthly)}<div class="tiny muted">เป้า ${money(data.monthlyTarget)}</div></td>
            <td class="t-nowrap">${r.feePaidUntil ? formatDate(r.feePaidUntil) : '-'}</td>
            <td class="t-right">${r.activeKeys}</td>
            <td><div class="row-actions">${actions}</div></td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="7"><div class="empty-state">ยังไม่มีใบสมัครตัวแทน</div></td></tr>`;

  body.innerHTML = `
    <div class="section-head" style="margin-bottom:12px">
      <div><h3 class="card-title-lg">ตัวแทน &amp; API</h3>
        <p class="small muted">อนุมัติแล้วระบบหักค่าบริการ ${money(data.fee)} จากเครดิตผู้สมัคร และมอบยศตัวแทน (ราคาลด ${ctx.state.config.dealerDiscount}%)</p></div>
    </div>
    <div class="note-box" style="margin-bottom:14px">
      เงื่อนไข: ต้องขายได้ ${money(data.weeklyTarget)}/สัปดาห์ และ ${money(data.monthlyTarget)}/เดือน —
      ระบบประเมินอัตโนมัติเมื่อครบ ${data.trialDays} วัน ถ้ายอดขาย 30 วันไม่ถึง ${money(data.monthlyTarget)} จะปลดเป็น member
      และยกเลิก API key ทั้งหมด · ค้างค่าบริการ ${money(data.fee)}/เดือน จะถูกระงับการใช้ API
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>ผู้สมัคร</th><th>สถานะ</th><th class="t-right">ยอด 7 วัน</th><th class="t-right">ยอด 30 วัน</th><th>ชำระถึง</th><th class="t-right">API key</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="card" style="margin-top:16px">
      <h3 class="card-title">API สำหรับตัวแทน</h3>
      <div class="kv"><span>รายการสินค้า/ราคาตัวแทน</span><span class="mono tiny">GET /api/v1/products</span></div>
      <div class="kv"><span>ซื้อคีย์</span><span class="mono tiny">POST /api/v1/purchase</span></div>
      <p class="tiny muted" style="margin-top:8px">ตัวแทนสร้าง API key ได้เองที่หน้า “ตัวแทน/API” — ระบบส่งคีย์และตัดเครดิตทันทีในคำตอบเดียว</p>
    </div>`;

  const review = async (id, action, message) => {
    if (message) {
      const ok = await confirmModal(message);
      if (!ok) return;
    }
    try {
      const res = await api(`/admin/resellers/${id}/review`, { method: 'POST', body: { action } });
      toast(res.message, 'success', 6000);
      await loadTab('resellers', ctx);
    } catch (err) {
      toast(err.message, 'error', 6500);
    }
  };

  body.querySelectorAll('[data-approve-reseller]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = data.resellers.find((x) => x.id === Number(btn.dataset.approveReseller));
      review(btn.dataset.approveReseller, 'approve', {
        title: 'อนุมัติตัวแทน',
        message: `อนุมัติ ${r.username} เป็นตัวแทน และหักค่าบริการ ${money(data.fee)} จากเครดิต (คงเหลือ ${money(r.balance)} บาท) ใช่หรือไม่`,
        confirmText: 'อนุมัติ',
      });
    });
  });
  body.querySelectorAll('[data-reject-reseller]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = data.resellers.find((x) => x.id === Number(btn.dataset.rejectReseller));
      review(btn.dataset.rejectReseller, 'reject', {
        title: 'ไม่อนุมัติใบสมัคร',
        message: `ปฏิเสธใบสมัครของ ${r.username} ใช่หรือไม่`,
        confirmText: 'ไม่อนุมัติ',
        danger: true,
      });
    });
  });
  body.querySelectorAll('[data-revoke-reseller]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = data.resellers.find((x) => x.id === Number(btn.dataset.revokeReseller));
      review(btn.dataset.revokeReseller, 'revoke', {
        title: 'ปลดยศตัวแทน',
        message: `ปลด ${r.username} เป็น member และยกเลิก API key ทั้งหมด ใช่หรือไม่`,
        confirmText: 'ปลด',
        danger: true,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

async function settingsTab(body, ctx) {
  body.innerHTML = spinner();
  const cfg = await api('/config');
  body.innerHTML = `
    <div class="two-col">
      <div class="card">
        <h3 class="card-title">บัญชีรับโอนธนาคาร</h3>
        <p class="small muted" style="margin-bottom:14px">แอดมินตั้งค่าบัญชีเองได้ — ข้อมูลนี้จะแสดงให้ลูกค้าเห็นในหน้าเติมเงิน</p>
        <form data-form="bank" class="stack">
          <div class="field"><label>ชื่อธนาคาร</label>
            <input class="input" name="bankName" maxlength="60" value="${escapeHtml(cfg.bank.name)}" required /></div>
          <div class="field"><label>เลขบัญชี</label>
            <input class="input" name="bankAccount" maxlength="40" value="${escapeHtml(cfg.bank.account)}" required /></div>
          <div class="field"><label>ชื่อบัญชี</label>
            <input class="input" name="bankHolder" maxlength="60" value="${escapeHtml(cfg.bank.holder)}" required /></div>
          <div class="form-error" data-error></div>
          <button class="btn btn-primary" type="submit">บันทึกบัญชีธนาคาร</button>
        </form>
      </div>

      <div class="stack">
        <div class="card">
          <h3 class="card-title">เบอร์รับซองทรู (ล็อก)</h3>
          <div class="copy-box locked" style="margin-top:10px">
            <span>${escapeHtml(cfg.ticketPhone)}</span>
            <button type="button" data-copy-phone>คัดลอก</button>
          </div>
          <div class="lock-note">🔒 ระบบล็อกเบอร์นี้ถาวร ห้ามเพิ่มหรือแก้ไขเป็นเบอร์อื่น</div>
        </div>
        <div class="card">
          <h3 class="card-title">ค่าธรรมเนียม</h3>
          <div class="kv"><span>หักจากยอดเติมเงิน</span><span style="color:#ffcf8a;font-weight:700">${cfg.feePercent}%</span></div>
          <div class="kv"><span>ยอด 100 บาท ลูกค้าได้รับ</span><span>${money(100 - (100 * cfg.feePercent) / 100)}</span></div>
          <p class="tiny muted" style="margin-top:8px">ค่าธรรมเนียมถูกกำหนดโดยระบบและแสดงทุกครั้งที่เติมเงิน</p>
        </div>
        <div class="card">
          <h3 class="card-title">ข้อมูลร้าน</h3>
          <form data-form="store" class="stack" style="margin-top:10px">
            <div class="field"><label>ชื่อร้าน</label>
              <input class="input" name="storeName" maxlength="40" value="${escapeHtml(cfg.storeName)}" required /></div>
            <div class="field"><label>สโลแกน</label>
              <input class="input" name="tagline" maxlength="120" value="${escapeHtml(cfg.tagline)}" /></div>
            <div class="field"><label>หมายเหตุหน้าเติมเงิน</label>
              <textarea class="textarea" name="topupNote" maxlength="200">${escapeHtml(cfg.topupNote)}</textarea></div>
            <div class="form-error" data-error2></div>
            <button class="btn btn-primary" type="submit">บันทึกข้อมูลร้าน</button>
          </form>
        </div>
      </div>
    </div>`;

  body.querySelector('[data-copy-phone]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cfg.ticketPhone);
      toast('คัดลอกเบอร์แล้ว', 'success', 1600);
    } catch {
      toast('คัดลอกไม่สำเร็จ', 'error');
    }
  });

  const bankForm = body.querySelector('[data-form="bank"]');
  bankForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = bankForm.querySelector('[data-error]');
    errorEl.textContent = '';
    try {
      await api('/admin/settings', {
        method: 'POST',
        body: {
          bankName: bankForm.bankName.value.trim(),
          bankAccount: bankForm.bankAccount.value.trim(),
          bankHolder: bankForm.bankHolder.value.trim(),
        },
      });
      toast('บันทึกบัญชีธนาคารแล้ว', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  const storeForm = body.querySelector('[data-form="store"]');
  storeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = storeForm.querySelector('[data-error2]');
    errorEl.textContent = '';
    try {
      await api('/admin/settings', {
        method: 'POST',
        body: {
          storeName: storeForm.storeName.value.trim(),
          tagline: storeForm.tagline.value.trim(),
          topupNote: storeForm.topupNote.value.trim(),
        },
      });
      toast('บันทึกข้อมูลร้านแล้ว', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

/* ------------------------------------------------------------------ */
/* tickets                                                             */
/* ------------------------------------------------------------------ */

async function ticketsTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/tickets');
  if (!data.tickets.length) {
    body.innerHTML = `<div class="card"><div class="empty-state">ยังไม่มีเรื่องแจ้งจากลูกค้า</div></div>`;
    return;
  }
  body.innerHTML = `
    <div class="stack">${data.tickets
      .map(
        (t) => `<div class="card">
          <div class="row between wrap">
            <div><strong>${escapeHtml(t.subject)}</strong>
              <div class="tiny muted">${escapeHtml(t.username)} · ${formatDate(t.created_at)}</div></div>
            ${statusPill(t.status)}
          </div>
          <p class="small" style="margin-top:10px">${escapeHtml(t.message)}</p>
          ${
            t.reply
              ? `<div class="small" style="margin-top:10px;padding:9px 11px;border-radius:9px;background:rgba(47,208,127,.08);border:1px solid rgba(47,208,127,.2);color:#a8f5ca">ตอบแล้ว: ${escapeHtml(t.reply)}</div>`
              : ''
          }
          <div class="row" style="margin-top:12px;gap:8px">
            <input class="input" data-reply-input="${t.id}" maxlength="1000" placeholder="พิมพ์คำตอบถึงลูกค้า…" />
            <button class="btn btn-sm btn-primary" data-reply="${t.id}">ตอบกลับ</button>
          </div>
        </div>`,
      )
      .join('')}</div>`;

  data.tickets.forEach((t) => {
    body.querySelector(`[data-reply="${t.id}"]`).addEventListener('click', async () => {
      const input = body.querySelector(`[data-reply-input="${t.id}"]`);
      const reply = input.value.trim();
      if (reply.length < 2) return toast('กรุณาพิมพ์คำตอบ', 'error');
      try {
        await api(`/admin/tickets/${t.id}/reply`, { method: 'POST', body: { reply } });
        toast('ตอบกลับแล้ว', 'success');
        goTab('tickets');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* logs                                                                */
/* ------------------------------------------------------------------ */

async function logsTab(body) {
  body.innerHTML = spinner();
  const data = await api('/admin/logs');
  body.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>เวลา</th><th>ผู้ทำรายการ</th><th>กิจกรรม</th><th>รายละเอียด</th></tr></thead>
      <tbody>${
        data.logs.length
          ? data.logs
              .map(
                (l) => `<tr><td class="t-nowrap">${formatDate(l.created_at)}</td>
                <td>${escapeHtml(l.actor_name)}</td><td class="mono tiny">${escapeHtml(l.action)}</td>
                <td class="small">${escapeHtml(l.detail)}</td></tr>`,
              )
              .join('')
          : `<tr><td colspan="4"><div class="empty-state">ยังไม่มีบันทึก</div></td></tr>`
      }</tbody></table></div>`;
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

/* ----- อัปเดตหลังบ้านเรียลไทม์: แจ้งเตือนออเดอร์/คำขอเติมเงินใหม่ ----- */

let adminTimer = null;
let adminLiveRev = '';
let adminPending = -1;
let adminOrder = -1;

/* ------------------------------------------------------------------ */
/* คูปองส่วนลด                                                        */
/* ------------------------------------------------------------------ */

const COUPON_STATUS = {
  active: ['ใช้งานได้', 'pill-approved'],
  scheduled: ['รอเริ่มใช้', 'pill-pending'],
  expired: ['หมดอายุ', 'pill-rejected'],
  used_up: ['ใช้ครบแล้ว', 'pill-rejected'],
  disabled: ['ปิดใช้งาน', 'pill-rejected'],
};

function couponStatusPill(status) {
  const [label, cls] = COUPON_STATUS[status] || [status, 'pill-open'];
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

function toLocalInput(raw) {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function couponFields(c, products, categories) {
  const type = c.type === 'fixed' ? 'fixed' : 'percent';
  const productOptions = ['<option value="">ทุกสินค้า</option>']
    .concat(
      products.map(
        (p) =>
          `<option value="${p.id}" ${Number(c.productId) === Number(p.id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`,
      ),
    )
    .join('');
  const categoryOptions = ['<option value="">ทุกหมวดหมู่</option>']
    .concat(
      categories.map(
        (cat) =>
          `<option value="${cat.id}" ${Number(c.categoryId) === Number(cat.id) ? 'selected' : ''}>${escapeHtml(cat.name)}</option>`,
      ),
    )
    .join('');
  return `
    <div class="grid-2">
      <div class="field"><label>โค้ดคูปอง</label>
        <input class="input" name="code" maxlength="32" value="${escapeHtml(c.code || '')}" placeholder="เช่น VEXIS10" required /></div>
      <div class="field"><label>ประเภทส่วนลด</label>
        <select class="input" name="type">
          <option value="percent" ${type === 'percent' ? 'selected' : ''}>เปอร์เซ็นต์ (%)</option>
          <option value="fixed" ${type === 'fixed' ? 'selected' : ''}>จำนวนเงิน (บาท)</option>
        </select></div>
      <div class="field"><label>จำนวนส่วนลด</label>
        <input class="input" name="value" type="number" min="0.01" step="0.01" value="${Number(c.value ?? 10)}" required /></div>
      <div class="field"><label>ยอดซื้อขั้นต่ำ (บาท)</label>
        <input class="input" name="minSpend" type="number" min="0" step="1" value="${Number(c.minSpend ?? 0)}" /></div>
      <div class="field"><label>จำนวนครั้งที่ใช้ได้ทั้งหมด (0 = ไม่จำกัด)</label>
        <input class="input" name="maxUses" type="number" min="0" step="1" value="${Number(c.maxUses ?? 0)}" /></div>
      <div class="field"><label>จำกัดสิทธิ์ต่อสมาชิก (0 = ไม่จำกัด)</label>
        <input class="input" name="perUserLimit" type="number" min="0" step="1" value="${Number(c.perUserLimit ?? 1)}" /></div>
      <div class="field"><label>ใช้ได้กับสินค้า</label>
        <select class="input" name="productId">${productOptions}</select></div>
      <div class="field"><label>หรือเฉพาะหมวดหมู่</label>
        <select class="input" name="categoryId">${categoryOptions}</select></div>
      <div class="field"><label>วันเริ่มใช้ (ว่าง = ใช้ได้ทันที)</label>
        <input class="input" name="startsAt" type="datetime-local" value="${toLocalInput(c.startsAt)}" /></div>
      <div class="field"><label>วันหมดอายุ (ว่าง = ไม่หมดอายุ)</label>
        <input class="input" name="expiresAt" type="datetime-local" value="${toLocalInput(c.expiresAt)}" /></div>
    </div>
    <label class="checkbox-row"><input type="checkbox" name="active" ${c.active === false ? '' : 'checked'} /> <span>เปิดใช้งานคูปองนี้ (ปิดแล้วจะใช้โค้ดไม่ได้ทันที)</span></label>`;
}

function readCouponForm(form) {
  return {
    code: form.code.value.trim(),
    type: form.type.value,
    value: Number(form.value.value),
    minSpend: Number(form.minSpend.value) || 0,
    maxUses: Number(form.maxUses.value) || 0,
    perUserLimit: Number(form.perUserLimit.value) || 0,
    productId: form.productId.value ? Number(form.productId.value) : null,
    categoryId: form.categoryId.value ? Number(form.categoryId.value) : null,
    startsAt: form.startsAt.value,
    expiresAt: form.expiresAt.value,
    active: form.active.checked,
  };
}

async function couponsTab(body) {
  body.innerHTML = spinner();
  const [data, prodData, catData] = await Promise.all([
    api('/admin/coupons'),
    api('/admin/products'),
    api('/admin/categories'),
  ]);
  const products = prodData.products || [];
  const categories = catData.categories || [];

  const rows = data.coupons.length
    ? data.coupons
        .map((c) => {
          const scope = c.productName
            ? `สินค้า: ${escapeHtml(c.productName)}`
            : c.categoryName
              ? `หมวด: ${escapeHtml(c.categoryName)}`
              : 'ทุกสินค้า';
          const valueText = c.type === 'fixed' ? `ลด ${money(c.value)}` : `ลด ${c.value}%`;
          const limitText = c.maxUses > 0 ? `${c.usedCount}/${c.maxUses}` : `${c.usedCount} (ไม่จำกัด)`;
          return `<tr>
            <td><strong class="mono">${escapeHtml(c.code)}</strong><div class="tiny muted">${valueText} · ${scope}</div></td>
            <td class="tiny" data-label="เงื่อนไข">ขั้นต่ำ ${money(c.minSpend)}<div class="muted">ต่อคน ${c.perUserLimit > 0 ? c.perUserLimit + ' ครั้ง' : 'ไม่จำกัด'}</div></td>
            <td class="t-right" data-label="ใช้แล้ว">${limitText}</td>
            <td class="tiny" data-label="หมดอายุ">${c.expiresAt ? formatDate(c.expiresAt) : 'ไม่หมดอายุ'}</td>
            <td data-label="สถานะ">${couponStatusPill(c.status)}</td>
            <td data-label=""><div class="row-actions">
              <button class="btn btn-sm btn-ghost" data-usage="${c.id}">ประวัติ</button>
              <button class="btn btn-sm btn-ghost" data-edit="${c.id}">แก้ไข</button>
              <button class="btn btn-sm btn-ghost" data-toggle="${c.id}">${c.active ? 'ปิด' : 'เปิด'}</button>
              <button class="btn btn-sm btn-danger" data-del="${c.id}">ลบ</button>
            </div></td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="6"><div class="empty-state">ยังไม่มีคูปอง — สร้างคูปองแรกได้จากฟอร์มด้านบน</div></td></tr>`;

  body.innerHTML = `
    <div class="section-head" style="margin-bottom:12px">
      <div><h3 class="card-title-lg">คูปองส่วนลด</h3>
      <p class="small muted">ส่วนลดถูกคำนวณและตรวจสอบที่เซิร์ฟเวอร์ทุกครั้งที่ซื้อ — พิมพ์โค้ดแล้วระบบใช้ได้ทันที</p></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h4 class="card-title">สร้างคูปองใหม่</h4>
      <form data-form="coupon" class="stack" style="margin-top:10px">
        ${couponFields({}, products, categories)}
        <div class="form-error" data-error></div>
        <div><button class="btn btn-primary btn-sm" type="submit">สร้างคูปอง</button></div>
      </form>
    </div>
    <div class="table-wrap coupon-table"><table>
      <thead><tr><th>โค้ด / ส่วนลด</th><th>เงื่อนไข</th><th class="t-right">ใช้แล้ว</th><th>หมดอายุ</th><th>สถานะ</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  const form = body.querySelector('[data-form="coupon"]');
  const errorEl = body.querySelector('[data-error]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    try {
      await api('/admin/coupons', { method: 'POST', body: readCouponForm(form) });
      toast('สร้างคูปองแล้ว', 'success');
      await couponsTab(body);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  const byId = (id) => data.coupons.find((c) => c.id === Number(id));

  body.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api(`/admin/coupons/${btn.dataset.toggle}`, {
          method: 'PATCH',
          body: { action: 'toggle' },
        });
        toast(res.active ? 'เปิดใช้งานคูปองแล้ว' : 'ปิดใช้งานคูปองแล้ว', 'success');
        await couponsTab(body);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  body.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const coupon = byId(btn.dataset.edit);
      if (!coupon) return;
      const modal = openModal(`
        <h3>แก้ไขคูปอง ${escapeHtml(coupon.code)}</h3>
        <form data-form="coupon-edit" class="stack" style="margin-top:12px">
          ${couponFields(coupon, products, categories)}
          <div class="form-error" data-error></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" data-cancel>ยกเลิก</button>
            <button class="btn btn-primary" type="submit">บันทึก</button>
          </div>
        </form>`);
      const editForm = modal.overlay.querySelector('[data-form="coupon-edit"]');
      const editError = modal.overlay.querySelector('[data-error]');
      modal.overlay.querySelector('[data-cancel]').addEventListener('click', modal.close);
      editForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        editError.textContent = '';
        try {
          await api(`/admin/coupons/${coupon.id}`, { method: 'PATCH', body: readCouponForm(editForm) });
          modal.close();
          toast('บันทึกคูปองแล้ว', 'success');
          await couponsTab(body);
        } catch (err) {
          editError.textContent = err.message;
        }
      });
    });
  });

  body.querySelectorAll('[data-usage]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const coupon = byId(btn.dataset.usage);
      try {
        const res = await api(`/admin/coupons/${btn.dataset.usage}/usages`);
        const list = res.usages.length
          ? res.usages
              .map(
                (u) => `<tr><td class="t-nowrap">${formatDate(u.createdAt)}</td><td>${escapeHtml(u.username)}</td>
              <td class="tiny">${escapeHtml(u.productName || '-')}</td>
              <td class="t-right">${money(u.discount)}</td><td class="t-right">${money(u.total)}</td></tr>`,
              )
              .join('')
          : `<tr><td colspan="5"><div class="empty-state">ยังไม่มีการใช้คูปองนี้</div></td></tr>`;
        openModal(`
          <h3>ประวัติการใช้ ${escapeHtml(coupon ? coupon.code : '')}</h3>
          <div class="table-wrap" style="margin-top:12px"><table>
            <thead><tr><th>วันที่</th><th>สมาชิก</th><th>สินค้า</th><th class="t-right">ส่วนลด</th><th class="t-right">ยอดชำระ</th></tr></thead>
            <tbody>${list}</tbody>
          </table></div>`);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  body.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const coupon = byId(btn.dataset.del);
      if (!coupon) return;
      const ok = await confirmModal({
        title: 'ลบคูปอง',
        message: `ต้องการลบคูปอง “${coupon.code}” และประวัติการใช้งานทั้งหมดใช่หรือไม่`,
        confirmText: 'ลบคูปอง',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/admin/coupons/${coupon.id}`, { method: 'DELETE' });
        toast('ลบคูปองแล้ว', 'success');
        await couponsTab(body);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

async function adminLiveTick() {
  const body = document.getElementById('admin-body');
  if (!body) {
    if (adminTimer) clearInterval(adminTimer);
    adminTimer = null;
    return;
  }
  if (document.visibilityState === 'hidden') return;
  if (document.getElementById('modal-root')?.children.length) return;
  try {
    const data = await api('/live', { timeout: 8000 });
    if (!data.staff || data.rev === adminLiveRev) return;
    adminLiveRev = data.rev;
    const pendingNow = Number(data.staff.pendingTopups) || 0;
    const orderNow = Number(data.staff.lastOrderId) || 0;
    const pendingChanged = adminPending >= 0 && pendingNow !== adminPending;
    const orderChanged = adminOrder >= 0 && orderNow > adminOrder;
    adminPending = pendingNow;
    adminOrder = orderNow;
    if (pendingChanged && pendingNow > 0) toast(`มีคำขอเติมเงินรอตรวจ ${pendingNow} รายการ`, 'info', 6000);
    if (orderChanged) toast('มีคำสั่งซื้อใหม่เข้าระบบ', 'success', 5000);
    const chip = document.getElementById('admin-live');
    if (chip) {
      chip.textContent = pendingNow ? `● LIVE · ${pendingNow} รอตรวจ` : '● LIVE';
      chip.classList.toggle('alert', pendingNow > 0);
    }
    if (activeTab === 'overview' && (pendingChanged || orderChanged)) {
      await overviewTab(body, activeCtx, true);
    }
  } catch {
    /* ลองรอบถัดไป */
  }
}

function startAdminLive() {
  adminPending = -1;
  adminOrder = -1;
  adminLiveRev = '';
  if (adminTimer) clearInterval(adminTimer);
  adminTimer = setInterval(adminLiveTick, 5000);
  adminLiveTick();
}

async function loadTab(tab, ctx) {
  activeCtx = ctx;
  activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const body = document.getElementById('admin-body');
  if (!body) return;
  body.innerHTML = spinner();
  try {
    if (tab === 'overview') await overviewTab(body, ctx);
    else if (tab === 'topups') await topupsTab(body, ctx);
    else if (tab === 'coupons') await couponsTab(body, ctx);
    else if (tab === 'products') await productsTab(body, ctx);
    else if (tab === 'categories') await categoriesTab(body);
    else if (tab === 'users') await usersTab(body, ctx);
    else if (tab === 'resellers') await resellersTab(body, ctx);
    else if (tab === 'tickets') await ticketsTab(body);
    else if (tab === 'settings') await settingsTab(body, ctx);
    else if (tab === 'logs') await logsTab(body);
  } catch (err) {
    body.innerHTML = errorCard(err.message);
  }
}

export async function renderAdmin(ctx) {
  const { state, setPage, shell } = ctx;
  activeCtx = ctx;
  const tab = parseTab();
  const html = `
    <div class="page">
      <div class="admin-head">
        <div>
          <h1>หลังบ้าน</h1>
          <p class="small muted">${escapeHtml(state.me.username)} · ${escapeHtml(state.me.roleLabel)}</p>
        </div>
        <div class="spacer"></div>
        <span class="live-chip" id="admin-live" title="อัปเดตข้อมูลหลังบ้านเรียลไทม์">● LIVE</span>
        ${roleBadge(state.me.role, state.me.roleLabel)}
      </div>
      <div class="admin-tabs">
        ${TABS.map(
          ([key, label]) => `<button class="admin-tab ${key === tab ? 'active' : ''}" data-tab="${key}">${label}</button>`,
        ).join('')}
      </div>
      <div id="admin-body"></div>
    </div>`;
  if (typeof setPage === 'function') setPage(html);
  else ctx.app.innerHTML = shell(html);

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => goTab(btn.dataset.tab));
  });

  await loadTab(tab, ctx);
  startAdminLive();
}
