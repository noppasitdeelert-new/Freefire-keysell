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
  onUnauthorized,
} from './api.js?v=11';
import { mountCaptcha, captchaPayload } from './captcha.js';

const app = document.getElementById('app');

const BRAND = 'VEXIS';
const DEFAULT_DISCORD = 'https://discord.gg/2ZNazcaDbY';
const GATE_KEY = 'fk_gate_ok';
const GATE_TTL_MS = 12 * 3600 * 1000;

const state = {
  config: null,
  me: null,
  store: null,
  filter: { category: 0, q: '' },
  route: '',
};

/* ------------------------------------------------------------------ */
/* shared UI                                                           */
/* ------------------------------------------------------------------ */

function isStaff() {
  return state.me && state.me.rank <= 2;
}

function discordUrl() {
  return (state.config && state.config.discordUrl) || DEFAULT_DISCORD;
}

function discordButton(cls = 'btn btn-discord', label = 'เข้าร่วมกับเรา Discord') {
  return `<a class="${cls}" href="${discordUrl()}" target="_blank" rel="noopener noreferrer">💬 ${label}</a>`;
}

function navItems(me) {
  const items = [['#/', 'ร้านค้า', ''], ['#/topup', 'เติมเงิน', 'topup']];
  if (me) items.push(['#/account', 'บัญชีของฉัน', 'account']);
  if (me) items.push(['#/reseller', 'ตัวแทน/API', 'reseller']);
  if (me) items.push(['#/support', 'ซัพพอร์ต', 'support']);
  if (isStaff()) items.push(['#/admin', 'หลังบ้าน', 'admin']);
  return items;
}

function topbar() {
  const me = state.me;
  const navItem = (href, label, key) =>
    `<a class="nav-link ${state.route === key ? 'active' : ''}" href="${href}">${label}</a>`;
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="#/">
        <img class="brand-logo" src="/img/vexis-logo.svg" alt="${BRAND} logo" width="42" height="42" />
        <span class="brand-text"><strong>${BRAND}</strong><span>KEY STORE</span></span>
      </a>
      <nav class="main-nav">
        ${navItems(me).map(([href, label, key]) => navItem(href, label, key)).join('')}
      </nav>
      <div class="topbar-actions">
        <span class="live-chip" id="live-chip" title="ข้อมูลร้านอัปเดตเรียลไทม์">● LIVE</span>
        <a class="discord-chip" href="${discordUrl()}" target="_blank" rel="noopener noreferrer" title="เข้าร่วมกับเรา Discord" aria-label="เข้าร่วมกับเรา Discord">💬 <span>Discord</span></a>
        ${
          me
            ? `<span class="balance-chip" id="balance-chip">💰 ${money(me.balance)}</span>
               <a class="user-chip" href="#/account" title="${escapeHtml(me.roleLabel)}">
                 <span class="avatar">${escapeHtml(me.username.slice(0, 1).toUpperCase())}</span>
                 <span class="uname">${escapeHtml(me.username)}</span>
               </a>
               <button class="btn btn-sm btn-ghost desktop-logout" data-action="logout">ออก</button>`
            : `<a class="btn btn-sm btn-ghost desktop-login" href="#/login">เข้าสู่ระบบ</a>
               <a class="btn btn-sm btn-primary desktop-register" href="#/register">สมัครสมาชิก</a>`
        }
        <button class="menu-toggle" data-action="toggle-menu" aria-label="เปิดเมนู" aria-controls="mobile-menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>
  </header>
  ${mobileMenu(me)}`;
}

function mobileMenu(me) {
  const icons = { '': '🏠', topup: '💳', account: '👤', reseller: '🤝', support: '💬', admin: '🛠️' };
  const links = navItems(me)
    .map(
      ([href, label, key]) =>
        `<a class="mobile-link ${state.route === key ? 'active' : ''}" href="${href}" data-action="close-menu">
           <span class="mobile-link-icon">${icons[key] || '•'}</span>${label}
         </a>`,
    )
    .join('');
  return `
  <div class="mobile-menu" id="mobile-menu" aria-hidden="true">
    <div class="mobile-menu-backdrop" data-action="close-menu"></div>
    <aside class="mobile-menu-panel" role="dialog" aria-label="เมนูหลัก">
      <div class="mobile-menu-head">
        <span>เมนู</span>
        <button class="mobile-close" data-action="close-menu" aria-label="ปิดเมนู">✕</button>
      </div>
      <div class="mobile-user">
        <span class="avatar" style="width:40px;height:40px;font-size:15px">${
          me ? escapeHtml(me.username.slice(0, 1).toUpperCase()) : '?'
        }</span>
        <div>
          <strong>${me ? escapeHtml(me.username) : 'ยังไม่ได้เข้าสู่ระบบ'}</strong>
          <div class="tiny muted">${me ? escapeHtml(me.roleLabel) + ' · ' + money(me.balance) : 'เข้าสู่ระบบเพื่อสั่งซื้อ'}</div>
        </div>
      </div>
      <nav class="mobile-nav">${links}</nav>
      <a class="btn btn-discord btn-block" href="${discordUrl()}" target="_blank" rel="noopener noreferrer" style="margin-top:10px">💬 เข้าร่วมกับเรา Discord</a>
      <div class="spacer"></div>
      ${
        me
          ? `<button class="btn btn-ghost btn-block" data-action="logout">ออกจากระบบ</button>`
          : `<a class="btn btn-primary btn-block" href="#/register" data-action="close-menu">สมัครสมาชิก</a>
             <a class="btn btn-ghost btn-block" href="#/login" data-action="close-menu" style="margin-top:8px">เข้าสู่ระบบ</a>`
      }
      <p class="tiny muted center" style="margin-top:14px">เปิดให้บริการ 24/7<br>ส่งคีย์อัตโนมัติทุกวัน</p>
    </aside>
  </div>`;
}

function closeMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.remove('open');
  document.body.classList.remove('menu-open');
}

function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (!menu) return;
  const open = menu.classList.toggle('open');
  document.body.classList.toggle('menu-open', open);
}

function footer() {
  return `
  <footer class="footer">
    <div class="footer-inner">
      <div>
        <strong style="color:#e7e9f0">${BRAND} KEY STORE</strong> — ร้านขายคีย์ฟีฟายอัตโนมัติ<br>
        <span class="tiny">ระบบป้องกัน: Captcha Gate · Rate Limit · Payload Guard · Anti-Scraping</span>
        <nav class="footer-links">
          <a href="#/about">เกี่ยวกับเรา</a>
          <a href="#/contact">ติดต่อร้าน</a>
          <a href="#/faq">คำถามที่พบบ่อย</a>
          <a href="#/terms">เงื่อนไขการใช้บริการ</a>
          <a href="#/privacy">นโยบายความเป็นส่วนตัว</a>
        </nav>
        <div style="margin-top:10px">${discordButton('discord-chip')}</div>
      </div>
      <div class="tiny" style="text-align:right">
        เติมเงินผ่านซองทรู / โอนธนาคาร · หักค่าธรรมเนียม ${state.config ? state.config.feePercent : 3}%<br>
        ข้อมูลรับเงินแสดงเฉพาะผู้เข้าสู่ระบบ · ซัพพอร์ตผ่าน Ticket ในเว็บเท่านั้น
      </div>
      <a class="hp-link" href="/__hp" rel="nofollow noindex" tabindex="-1" aria-hidden="true">.</a>
    </div>
  </footer>`;
}

function shell(content) {
  return `<div id="topbar-root">${topbar()}</div><main id="main-root" style="flex:1">${content}</main>${footer()}`;
}

/* เปลี่ยนเฉพาะเนื้อหาหน้า โดยไม่สร้าง top bar ใหม่ทั้งก้อน
   ทำให้กดเมนูแล้วไม่กระพริบ/ไม่รีหน้า */
function setPage(content) {
  const main = document.getElementById('main-root');
  if (!main) {
    app.innerHTML = shell(content);
    return;
  }
  main.innerHTML = content;
  const top = document.getElementById('topbar-root');
  if (top) top.innerHTML = topbar();
}

function loader() {
  return `<div class="page"><div class="loader"><div class="spinner"></div></div></div>`;
}

function errorState(message, { retry = false } = {}) {
  return `<div class="page"><div class="card center" style="max-width:440px;margin:60px auto">
    <h3>เกิดข้อผิดพลาด</h3>
    <p class="muted small" style="margin:8px 0 18px">${escapeHtml(message)}</p>
    ${retry ? '<button class="btn btn-primary" type="button" data-retry>ลองใหม่อีกครั้ง</button>' : '<a class="btn btn-primary" href="#/">กลับหน้าแรก</a>'}
    <p class="tiny muted" style="margin-top:12px">ถ้ายังขึ้นซ้ำ ลองปิดแล้วเปิดหน้าเว็บใหม่ หรือรอสักครู่แล้วกดลองใหม่</p>
  </div></div>`;
}

function setRoute(name) {
  state.route = name;
}

function updateBalanceChip() {
  const chip = document.getElementById('balance-chip');
  if (chip && state.me) chip.textContent = `💰 ${money(state.me.balance)}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('คัดลอกแล้ว', 'success', 1800);
  } catch {
    toast('คัดลอกไม่สำเร็จ กรุณาคัดลอกด้วยตนเอง', 'error');
  }
}

function codesHtml(codes) {
  if (!codes || !codes.length) return '<span class="tiny muted">-</span>';
  return `<div class="key-list">
    ${codes
      .map(
        (code) => `<div class="key-item"><code>${escapeHtml(code)}</code>
          <button class="btn btn-sm btn-ghost" data-copy="${escapeHtml(code)}">คัดลอก</button></div>`,
      )
      .join('')}
  </div>`;
}

function showDelivery(res) {
  const order = res.order;
  const codes = order.codes || [];
  const modal = openModal(`
    <h3>✅ ส่งคีย์อัตโนมัติแล้ว</h3>
    <p class="modal-sub">${escapeHtml(order.productName)} × ${order.quantity} · ออเดอร์ #${order.id}<br>
      ระบบหักเครดิตอัตโนมัติ ${money(order.total)} และส่งคีย์ให้ทันที</p>
    ${codesHtml(codes)}
    <div class="note-box" style="margin-top:12px">คีย์ถูกบันทึกไว้ใน “ประวัติการซื้อ” แล้ว — กด “คัดลอก” เพื่อเอาไปใช้ต่อได้เลย หรือเปิดดูซ้ำได้ที่หน้าบัญชีของฉัน</div>
    <div class="fee-preview" style="margin-top:14px">
      <div class="line total"><span>เครดิตคงเหลือ</span><span>${money(res.balance)}</span></div>
    </div>
    <div class="modal-actions">
      ${codes.length > 1 ? `<button class="btn btn-ghost" data-copy="${escapeHtml(codes.join('\n'))}">คัดลอกทั้งหมด</button>` : ''}
      <a class="btn btn-ghost" href="#/account" data-history>ประวัติการซื้อ</a>
      <button class="btn btn-primary" data-close>ปิด</button>
    </div>
  `);
  modal.overlay.querySelector('[data-close]').addEventListener('click', modal.close);
  modal.overlay.querySelector('[data-history]').addEventListener('click', modal.close);
}

async function refreshMe() {
  try {
    const data = await api('/me');
    state.me = data.user;
  } catch {
    state.me = null;
  }
}

/* ------------------------------------------------------------------ */
/* home / storefront                                                   */
/* ------------------------------------------------------------------ */

function catalogProducts() {
  if (!state.store) return [];
  const { category, q } = state.filter;
  const needle = q.trim().toLowerCase();
  return state.store.products.filter((p) => {
    if (category && p.categoryId !== category) return false;
    if (!needle) return true;
    return (
      p.name.toLowerCase().includes(needle) ||
      (p.description || '').toLowerCase().includes(needle) ||
      (p.categoryName || '').toLowerCase().includes(needle)
    );
  });
}

function productCard(p) {
  const isDealer = state.me && state.me.role === 'dealer';
  return `
    <article class="product-card" data-product="${p.id}">
      <div class="product-media">
        <img src="${escapeHtml(p.image || '/img/vexis-banner.svg')}" alt="${escapeHtml(p.name)}" loading="lazy" decoding="async" />
        <span class="product-tag">${escapeHtml(p.categoryName)}</span>
        ${p.duration ? `<span class="product-duration">⏱️ ${escapeHtml(p.duration)}</span>` : ''}
      </div>
      <h3>${escapeHtml(p.name)}</h3>
      <p class="desc">${escapeHtml(p.description || 'ส่งคีย์ทันทีหลังชำระเงิน')}</p>
      <div class="product-price">
        <strong>${money(p.yourPrice)}</strong>
        ${isDealer && p.price > p.yourPrice ? `<s>${money(p.price)}</s>` : ''}
      </div>
      ${
        isDealer
          ? `<div class="dealer-note">ราคาตัวแทน ลด ${state.config.dealerDiscount}% จากราคาปกติ</div>`
          : ''
      }
      <div class="product-meta">
        <span class="stock-badge ${p.soldOut ? 'out' : ''}" data-stock>คงเหลือ <b>${p.stock}</b> ชิ้น</span>
        <button class="btn btn-sm ${p.soldOut ? 'btn-ghost' : 'btn-primary'}" ${
          p.soldOut ? 'disabled' : ''
        } data-buy="${p.id}">${p.soldOut ? 'สินค้าหมด' : 'ซื้อเลย'}</button>
      </div>
    </article>`;
}

function chipsHtml() {
  return (
    `<button class="chip ${state.filter.category === 0 ? 'active' : ''}" data-cat="0">ทั้งหมด</button>` +
    state.store.categories
      .map(
        (c) =>
          `<button class="chip ${state.filter.category === c.id ? 'active' : ''}" data-cat="${c.id}">${escapeHtml(
            c.name,
          )} <span class="tiny">(${c.count})</span></button>`,
      )
      .join('')
  );
}

function paintChips() {
  const el = document.getElementById('category-chips');
  if (el) el.innerHTML = chipsHtml();
}

function paintProducts() {
  const grid = document.getElementById('product-grid');
  if (!grid) return;
  const items = catalogProducts();
  if (!items.length) {
    grid.innerHTML = `<div class="card center muted" style="grid-column:1/-1">ไม่พบสินค้าที่ตรงกับคำค้นหา</div>`;
    return;
  }
  grid.innerHTML = items.map(productCard).join('');
}

async function renderHome() {
  setRoute('');
  setPage(loader());
  try {
    state.store = await api('/store');
    state.me = state.store.viewer || state.me;
  } catch (err) {
    if (err && err.data && err.data.gateRequired) {
      await showGate(err.message);
      return;
    }
    setPage(errorState(err.message));
    return;
  }
  const totalStock = state.store.products.reduce((sum, p) => sum + p.stock, 0);
  const bestSellers = [...state.store.products]
    .sort((a, b) => b.soldCount - a.soldCount || b.stock - a.stock)
    .slice(0, 3);
  setPage(`
    <div class="page">
      <section class="hero">
        <div class="hero-inner">
          <span class="eyebrow">🔥 ส่งคีย์อัตโนมัติ 24 ชั่วโมง</span>
          <h1>คีย์ฟีฟาย <em>ราคาส่ง</em><br>ถูกกว่าที่คิด ส่งไวทุกออเดอร์</h1>
          <p>${escapeHtml(state.config.tagline || 'ร้านคีย์ฟีฟายราคาส่ง')} — เติมเงินผ่านซองทรูหรือโอนธนาคาร ระบบตรวจสอบและเติมเครดิตโดยแอดมิน</p>
          <div class="hero-actions">
            <button class="btn btn-primary" data-action="scroll-products">เลือกซื้อคีย์</button>
            <a class="btn btn-ghost" href="#/topup">เติมเงินเข้าระบบ</a>
            ${discordButton('btn btn-discord')}
          </div>
          <div class="hero-stats">
            <div><strong>${state.store.products.length}</strong><span>รายการสินค้า</span></div>
            <div><strong>${totalStock}</strong><span>สต็อกพร้อมส่ง</span></div>
            <div><strong>${state.config.feePercent}%</strong><span>ค่าธรรมเนียมเติมเงิน</span></div>
          </div>
        </div>
      </section>

      <div class="trust-strip">
        <div class="trust-item">
          <span class="trust-icon">⚡</span>
          <div><strong>เปิดให้บริการ 24/7</strong><span>ส่งไวทุกออเดอร์ ระบบตัดสต็อกทันที</span></div>
        </div>
        <div class="trust-item">
          <span class="trust-icon">🛡️</span>
          <div><strong>ปลอดภัยด้วย Cloudflare</strong><span>แคปช่า + จำกัดการยิงคำขอ</span></div>
        </div>
        <div class="trust-item">
          <span class="trust-icon">💬</span>
          <div><strong>ซัพพอร์ตในเว็บ</strong><span>แอดมินตอบผ่านระบบ Ticket</span></div>
        </div>
      </div>

      ${
        bestSellers.length
          ? `<section class="section">
              <div class="section-head">
                <div>
                  <h2>สินค้าขายดี</h2>
                  <p>คีย์ยอดนิยมที่ลูกค้าเลือกซื้อมากที่สุด — ส่งอัตโนมัติทุกออเดอร์</p>
                </div>
                <span class="best-badge">🔥 BEST SELLER</span>
              </div>
              <div class="grid grid-3">${bestSellers.map(productCard).join('')}</div>
            </section>`
          : ''
      }

      <section class="section">
        <div class="section-head">
          <div>
            <h2>สินค้าทั้งหมด</h2>
            <p>${state.me && state.me.role === 'dealer' ? 'คุณเป็นตัวแทน — ราคาที่เห็นถูกลง ' + state.config.dealerDiscount + '% แล้ว' : 'ราคาปกติสำหรับสมาชิก'}</p>
          </div>
          <input class="input" id="search-input" placeholder="ค้นหาสินค้า…" style="max-width:260px" autocomplete="off" />
        </div>
        <div class="chips" id="category-chips">${chipsHtml()}</div>
        <div class="grid grid-3" id="product-grid" style="margin-top:18px"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>ขั้นตอนการสั่งซื้อ</h2>
            <p>ซื้อคีย์ได้ใน 4 ขั้นตอน ใช้เวลาไม่ถึง 2 นาที</p>
          </div>
        </div>
        <div class="steps">
          <div class="step"><span class="step-no">01</span><h3>สมัครสมาชิก</h3><p>สมัครด้วยชื่อผู้ใช้และรหัสผ่าน ใช้เวลาไม่กี่วินาที</p></div>
          <div class="step"><span class="step-no">02</span><h3>เติมเงินเข้าระบบ</h3><p>โอนผ่านซองทรูหรือธนาคาร แจ้งยอด แล้วรอแอดมินอนุมัติ</p></div>
          <div class="step"><span class="step-no">03</span><h3>เลือกคีย์ที่ต้องการ</h3><p>เลือกสินค้าและจำนวน ระบบจะคำนวณยอดให้ก่อนยืนยัน</p></div>
          <div class="step"><span class="step-no">04</span><h3>รับคีย์ทันที</h3><p>ระบบตัดเครดิตและส่งคีย์อัตโนมัติ พร้อมเก็บประวัติให้ดูซ้ำได้</p></div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>รีวิวจากลูกค้า</h2>
            <p>คะแนนเฉลี่ย 4.9 จากลูกค้าที่ซื้อคีย์กับ ${BRAND}</p>
          </div>
          <span class="best-badge">⭐ 4.9 / 5</span>
        </div>
        <div class="review-grid">
          <div class="review-card"><div class="stars">★★★★★</div><p>“ซื้อคีย์ Phantom แล้วได้ทันทีในไม่กี่วินาที ระบบตัดเงินแล้วส่งคีย์อัตโนมัติจริง ๆ”</p><span>— Nont, Member</span></div>
          <div class="review-card"><div class="stars">★★★★★</div><p>“ราคาตัวแทนถูกกว่าปกติ 35% ใช้ API ซื้อคีย์เข้าร้านตัวเองได้สะดวกมาก”</p><span>— Kla, ตัวแทน</span></div>
          <div class="review-card"><div class="stars">★★★★★</div><p>“แอดมินตอบไว เติมเงินแล้วอนุมัติเร็ว คีย์ไม่เคยขาด”</p><span>— Mint, Member</span></div>
        </div>
      </section>

      <section class="section">
        <div class="two-col">
          <div class="card">
            <span class="eyebrow">💳 เติมเงินง่าย</span>
            <h3 class="card-title-lg" style="margin-top:12px">เติมผ่านซองทรู หรือโอนธนาคาร</h3>
            <p class="muted small" style="margin-top:6px">
              แจ้งยอดพร้อมลิงก์ซอง/หลักฐานโอน แอดมินตรวจสอบแล้วเติมเครดิตเข้าบัญชีให้ทันที
              โดยหักค่าธรรมเนียม ${state.config.feePercent}% จากยอดที่ได้รับ
            </p>
            <div class="row wrap" style="margin-top:16px">
              <a class="btn btn-primary" href="#/topup">เติมเงินเลย</a>
              <span class="tiny muted">🔒 ข้อมูลรับเงินแสดงเฉพาะผู้ที่เข้าสู่ระบบแล้ว</span>
            </div>
          </div>
          <div class="card">
            <h3 class="card-title">ระดับสมาชิก</h3>
            <div class="kv"><span>Owner</span><span>ผู้ดูแลสูงสุด · จัดการยศได้</span></div>
            <div class="kv"><span>Admin</span><span>เพิ่มสต็อก/สินค้า · ซัพพอร์ต</span></div>
            <div class="kv"><span>ตัวแทน/ตัวขาย</span><span>ซื้อคีย์ราคาลด ${state.config.dealerDiscount}%</span></div>
            <div class="kv"><span>Member</span><span>ซื้อสินค้า · เติมเงิน · แจ้งปัญหา</span></div>
          </div>
        </div>
      </section>
    </div>
  `);
  paintProducts();

  const search = document.getElementById('search-input');
  if (search) {
    search.value = state.filter.q;
    search.addEventListener('input', () => {
      state.filter.q = search.value.slice(0, 60);
      paintProducts();
    });
  }
}

async function refreshStoreProducts() {
  try {
    state.store = await api('/store');
    state.me = state.store.viewer || state.me;
    paintProducts();
    paintChips();
    updateBalanceChip();
  } catch {
    /* keep old list */
  }
}

function openBuyModal(product) {
  if (!state.me) {
    toast('กรุณาเข้าสู่ระบบก่อนซื้อสินค้า', 'info');
    location.hash = '#/login';
    return;
  }
  const maxQty = Math.min(10, product.stock);
  const modal = openModal(`
    <h3>${escapeHtml(product.name)}</h3>
    <p class="modal-sub">${escapeHtml(product.description || '')}</p>
    <div class="kv"><span>ราคาต่อชิ้น</span><span>${money(product.yourPrice)}</span></div>
    <div class="kv"><span>สต็อกคงเหลือ</span><span>${product.stock} ชิ้น</span></div>
    <div class="field" style="margin-top:14px">
      <label>จำนวนที่ต้องการ</label>
      <input class="input" id="buy-qty" type="number" min="1" max="${maxQty}" value="1" />
    </div>
    <div class="field" style="margin-top:12px">
      <label for="buy-coupon">โค้ดคูปองส่วนลด</label>
      <div class="coupon-row">
        <input class="input" id="buy-coupon" maxlength="32" autocomplete="off" placeholder="กรอกโค้ดคูปอง (ถ้ามี)" />
        <button class="btn btn-ghost btn-sm" type="button" data-apply-coupon>ใช้คูปอง</button>
      </div>
      <div class="field-hint" data-coupon-msg></div>
    </div>
    <div class="fee-preview" style="margin-top:14px">
      <div class="line"><span>ราคาก่อนลด</span><span data-subtotal>${money(product.yourPrice)}</span></div>
      <div class="line" data-discount-row hidden><span>ส่วนลดคูปอง</span><span data-discount style="color:#7ff0b5">-฿0.00</span></div>
      <div class="line"><span>ยอดชำระรวม</span><span data-total>${money(product.yourPrice)}</span></div>
      <div class="line"><span>เครดิตคงเหลือหลังซื้อ</span><span data-after>${money(state.me.balance - product.yourPrice)}</span></div>
    </div>
    <div class="form-error" data-error></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>ยกเลิก</button>
      <button class="btn btn-primary" data-confirm>ยืนยันซื้อ</button>
    </div>
  `);

  const requestToken =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const qtyInput = modal.overlay.querySelector('#buy-qty');
  const couponInput = modal.overlay.querySelector('#buy-coupon');
  const applyBtn = modal.overlay.querySelector('[data-apply-coupon]');
  const couponMsg = modal.overlay.querySelector('[data-coupon-msg]');
  const subtotalEl = modal.overlay.querySelector('[data-subtotal]');
  const discountRow = modal.overlay.querySelector('[data-discount-row]');
  const discountEl = modal.overlay.querySelector('[data-discount]');
  const totalEl = modal.overlay.querySelector('[data-total]');
  const afterEl = modal.overlay.querySelector('[data-after]');
  const errorEl = modal.overlay.querySelector('[data-error]');
  const confirmBtn = modal.overlay.querySelector('[data-confirm]');
  let applied = null;

  const recalc = () => {
    const qty = Math.min(maxQty, Math.max(1, parseInt(qtyInput.value, 10) || 1));
    qtyInput.value = String(qty);
    const subtotal = Math.round(product.yourPrice * qty * 100) / 100;
    const discount = applied ? Math.min(subtotal, applied.discount) : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;
    subtotalEl.textContent = money(subtotal);
    discountRow.hidden = !applied;
    discountEl.textContent = '-' + money(discount);
    totalEl.textContent = money(total);
    const after = state.me.balance - total;
    afterEl.textContent = money(after);
    afterEl.style.color = after < 0 ? '#ff8d9b' : '';
    errorEl.textContent = after < 0 ? 'เครดิตไม่พอ กรุณาเติมเงินก่อน' : '';
    confirmBtn.disabled = after < 0;
    return { qty, subtotal, total };
  };

  // ตรวจคูปองกับเซิร์ฟเวอร์เท่านั้น (frontend ใช้แค่แสดงผล)
  const applyCoupon = async (code, silent = false) => {
    const value = String(code || '').trim();
    if (!value) {
      applied = null;
      couponMsg.textContent = '';
      recalc();
      return;
    }
    const qty = Math.min(maxQty, Math.max(1, parseInt(qtyInput.value, 10) || 1));
    applyBtn.disabled = true;
    if (!silent) applyBtn.textContent = 'กำลังตรวจ…';
    try {
      const res = await api('/coupons/validate', {
        method: 'POST',
        body: { code: value, productId: product.id, quantity: qty },
      });
      applied = { code: res.coupon.code, discount: Number(res.discount) || 0 };
      couponInput.value = res.coupon.code;
      couponMsg.style.color = '#7ff0b5';
      couponMsg.textContent = `${res.message} (${res.coupon.label})`;
      if (!silent) toast(res.message, 'success');
    } catch (err) {
      applied = null;
      couponMsg.style.color = '#ff8d9b';
      couponMsg.textContent = err.message;
      if (!silent) toast(err.message, 'error');
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = 'ใช้คูปอง';
      recalc();
    }
  };

  applyBtn.addEventListener('click', () => applyCoupon(couponInput.value));
  couponInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyCoupon(couponInput.value);
    }
  });
  qtyInput.addEventListener('input', () => {
    recalc();
    if (applied) applyCoupon(applied.code, true);
  });
  recalc();

  modal.overlay.querySelector('[data-cancel]').addEventListener('click', modal.close);
  confirmBtn.addEventListener('click', async () => {
    const { qty } = recalc();
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'กำลังดำเนินการ…';
    try {
      const res = await api('/orders', {
        method: 'POST',
        body: {
          productId: product.id,
          quantity: qty,
          clientToken: requestToken,
          couponCode: applied ? applied.code : '',
        },
      });
      state.me.balance = res.balance;
      live.balance = Number(res.balance) || 0;
      live.lastOrderId = Math.max(live.lastOrderId, Number(res.order.id) || 0);
      updateBalanceChip();
      modal.close();
      showDelivery(res);
      toast(
        res.order.discount > 0
          ? `ซื้อสำเร็จ! ลด ${money(res.order.discount)} (คูปอง ${res.order.couponCode}) — ส่งคีย์อัตโนมัติ ${res.order.quantity} รายการ`
          : `ซื้อสำเร็จ! ส่งคีย์อัตโนมัติ ${res.order.quantity} รายการ`,
        'success',
      );
      await refreshStoreProducts();
    } catch (err) {
      errorEl.textContent = err.message;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'ยืนยันซื้อ';
    }
  });
}

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

function authShell(inner) {
  return `<div class="auth-wrap">${inner}</div>`;
}

async function renderLogin() {
  setRoute('login');
  setPage(authShell(`
    <div class="card auth-card">
      <h1>เข้าสู่ระบบ</h1>
      <p class="sub">ยินดีต้อนรับกลับ — เข้าสู่ระบบเพื่อซื้อคีย์และเติมเงิน</p>
      <form data-form="login" class="stack" novalidate>
        <div class="field">
          <label for="login-username">ชื่อผู้ใช้</label>
          <input class="input" id="login-username" name="username" autocomplete="username" maxlength="20" required placeholder="ชื่อผู้ใช้ของคุณ" />
        </div>
        <div class="field">
          <label for="login-password">รหัสผ่าน</label>
          <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" maxlength="72" required placeholder="รหัสผ่าน" />
        </div>
        <div id="captcha-slot"></div>
        <div class="form-error" data-error></div>
        <button class="btn btn-primary btn-block" type="submit" data-submit>เข้าสู่ระบบ</button>
      </form>
      <div class="auth-alt">ยังไม่มีบัญชี? <a href="#/register">สมัครสมาชิก</a></div>
      <div class="divider"></div>
      <p class="tiny muted center">หน้านี้ป้องกันด้วย Captcha Gate + แคปช่า และจำกัดจำนวนครั้งในการเข้าสู่ระบบ<br>ระบบไม่แสดงบัญชีหรือรหัสผ่านของ Owner/แอดมินบนหน้านี้เด็ดขาด</p>
    </div>
  `));

  const captchaSlot = document.getElementById('captcha-slot');
  await mountCaptcha(captchaSlot, state.config);

  const form = document.querySelector('[data-form="login"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = form.querySelector('[data-error]');
    const submit = form.querySelector('[data-submit]');
    errorEl.textContent = '';
    submit.disabled = true;
    submit.textContent = 'กำลังเข้าสู่ระบบ…';
    try {
      const res = await api('/auth/login', {
        method: 'POST',
        body: {
          username: form.username.value.trim(),
          password: form.password.value,
          ...captchaPayload(captchaSlot),
        },
      });
      state.me = res.user;
      try {
        state.config = await api('/config');
      } catch {
        /* ใช้ค่าเดิม */
      }
      toast(`ยินดีต้อนรับ ${res.user.username}`, 'success');
      if (isStaff()) location.hash = '#/admin';
      else location.hash = '#/';
    } catch (err) {
      errorEl.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'เข้าสู่ระบบ';
      if (captchaSlot.dataset.mode === 'math') mountCaptcha(captchaSlot, state.config);
      else if (window.turnstile && captchaSlot.querySelector('.turnstile-slot')) {
        window.turnstile.reset(captchaSlot.querySelector('.turnstile-slot'));
      }
    }
  });
}

async function renderRegister() {
  setRoute('register');
  setPage(authShell(`
    <div class="card auth-card">
      <h1>สมัครสมาชิก</h1>
      <p class="sub">สมัครฟรี เริ่มต้นที่ยศ Member — ซื้อสินค้าและเติมเงินได้ทันที</p>
      <form data-form="register" class="stack" novalidate>
        <div class="field">
          <label for="reg-username">ชื่อผู้ใช้</label>
          <input class="input" id="reg-username" name="username" autocomplete="username" minlength="3" maxlength="20" required placeholder="a-z 0-9 _ . ความยาว 3-20 ตัว" />
        </div>
        <div class="field">
          <label for="reg-password">รหัสผ่าน</label>
          <input class="input" id="reg-password" name="password" type="password" autocomplete="new-password" minlength="6" maxlength="72" required placeholder="อย่างน้อย 6 ตัวอักษร" />
        </div>
        <div class="field">
          <label for="reg-password2">ยืนยันรหัสผ่าน</label>
          <input class="input" id="reg-password2" name="password2" type="password" autocomplete="new-password" maxlength="72" required placeholder="พิมพ์รหัสผ่านอีกครั้ง" />
        </div>
        <div class="field">
          <label for="reg-contact">ช่องทางติดต่อ (ไม่บังคับ)</label>
          <input class="input" id="reg-contact" name="contact" maxlength="60" placeholder="LINE ID / เบอร์โทร" />
        </div>
        <div id="captcha-slot"></div>
        <div class="form-error" data-error></div>
        <button class="btn btn-primary btn-block" type="submit" data-submit>สมัครสมาชิก</button>
      </form>
      <div class="auth-alt">มีบัญชีอยู่แล้ว? <a href="#/login">เข้าสู่ระบบ</a></div>
      <div class="divider"></div>
      <p class="tiny muted center">การสมัครต้องผ่าน Captcha Gate + แคปช่า และจำกัดจำนวนครั้งเพื่อป้องกันบอท</p>
    </div>
  `));

  const captchaSlot = document.getElementById('captcha-slot');
  await mountCaptcha(captchaSlot, state.config);

  const form = document.querySelector('[data-form="register"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = form.querySelector('[data-error]');
    const submit = form.querySelector('[data-submit]');
    errorEl.textContent = '';
    if (form.password.value !== form.password2.value) {
      errorEl.textContent = 'รหัสผ่านทั้งสองช่องไม่ตรงกัน';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'กำลังสมัคร…';
    try {
      const res = await api('/auth/register', {
        method: 'POST',
        body: {
          username: form.username.value.trim(),
          password: form.password.value,
          contact: form.contact.value.trim(),
          ...captchaPayload(captchaSlot),
        },
      });
      state.me = res.user;
      toast('สมัครสมาชิกสำเร็จ ยินดีต้อนรับ!', 'success');
      location.hash = '#/';
    } catch (err) {
      errorEl.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'สมัครสมาชิก';
      if (captchaSlot.dataset.mode === 'math') mountCaptcha(captchaSlot, state.config);
      else if (window.turnstile && captchaSlot.querySelector('.turnstile-slot')) {
        window.turnstile.reset(captchaSlot.querySelector('.turnstile-slot'));
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* top-up                                                              */
/* ------------------------------------------------------------------ */

function topupFormHtml(method) {
  const isEnvelope = method === 'envelope';
  return `
    <form data-form="topup" class="stack" novalidate>
      <div class="field">
        <label>จำนวนเงินที่ต้องการเติม (บาท)</label>
        <div class="amount-presets">
          ${[50, 100, 300, 500, 1000]
            .map((v) => `<button type="button" data-amount="${v}">฿${v.toLocaleString('th-TH')}</button>`)
            .join('')}
        </div>
        <input class="input" name="amount" type="number" min="20" max="10000" step="1" value="100" required inputmode="numeric" />
        <span class="field-hint">ขั้นต่ำ 20 บาท · สูงสุด 10,000 บาท ต่อรายการ</span>
      </div>
      <div class="field">
        <label>${isEnvelope ? 'ลิงก์ซองทรู (อั่งเปา)' : 'เลขอ้างอิง / หลักฐานการโอน'}</label>
        <input class="input" name="reference" maxlength="300" required placeholder="${
          isEnvelope ? 'https://gift.truemoney.com/campaign/?v=…' : 'เช่น REF-2024-XXXX หรือเลขสลิป'
        }" />
        <span class="field-hint">${
          isEnvelope ? 'วางลิงก์ซองทรูที่ส่งเข้าซองของร้านเท่านั้น' : 'แนบเลขอ้างอิงที่ใช้โอน เพื่อให้แอดมินตรวจสอบ'
        }</span>
      </div>
      <div class="field">
        <label>หมายเหตุ (ไม่บังคับ)</label>
        <input class="input" name="note" maxlength="200" placeholder="เช่น โอนเมื่อ 14:20" />
      </div>
      <div class="fee-preview">
        <div class="line"><span>ยอดแจ้งเติม</span><span data-fee-amount>${money(100)}</span></div>
        <div class="line"><span>ค่าธรรมเนียม ${state.config.feePercent}%</span><span data-fee-fee>-${money(3)}</span></div>
        <div class="line total"><span>เครดิตที่ได้รับจริง</span><span data-fee-net>${money(97)}</span></div>
      </div>
      <div class="form-error" data-error></div>
      <button class="btn btn-primary btn-block" type="submit" data-submit>แจ้งเติมเงิน</button>
    </form>`;
}

async function renderTopup() {
  setRoute('topup');
  if (!state.me) {
    toast('กรุณาเข้าสู่ระบบก่อนเติมเงิน', 'info');
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let data;
  try {
    data = await api('/topups');
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }
  const cfg = state.config;
  // ข้อมูลรับเงินส่งมาพร้อมคำขอนี้ (ต้องเข้าสู่ระบบแล้วเท่านั้น)
  const pay = data.payment || { ticketPhone: cfg.ticketPhone, bank: cfg.bank, note: cfg.topupNote };
  let method = 'envelope';

  // สถานะคำขอเติมเงินล่าสุด — อัปเดตอัตโนมัติเมื่อแอดมินตรวจสอบเสร็จ
  const latest = data.topups[0];
  const pendingCount = data.topups.filter((t) => t.status === 'pending').length;
  let statusBanner = '';
  if (latest) {
    if (latest.status === 'pending') {
      statusBanner = `<div class="note-box" style="margin-bottom:14px">
        ⏳ คำขอเติมเงิน ${money(latest.amount)} (${latest.method === 'envelope' ? 'ซองทรู' : 'โอนธนาคาร'}) กำลังตรวจสอบ${pendingCount > 1 ? ` · รอตรวจทั้งหมด ${pendingCount} รายการ` : ''} — เมื่อยืนยันยอดแล้วเครดิตจะเข้าอัตโนมัติและหน้านี้จะอัปเดตเอง
      </div>`;
    } else if (latest.status === 'approved') {
      statusBanner = `<div class="note-box" style="margin-bottom:14px;border-color:rgba(47,208,127,0.4);color:#7ff0b5">
        ✅ เติมเงิน ${money(latest.amount)} สำเร็จ — หักค่าธรรมเนียม ${money(latest.fee)} เข้าเครดิต ${money(latest.net)}
      </div>`;
    } else {
      statusBanner = `<div class="note-box" style="margin-bottom:14px;border-color:rgba(255,80,100,0.4);color:#ff9fb0">
        ❌ รายการเติมเงิน ${money(latest.amount)} ถูกปฏิเสธ${latest.note ? ` — ${escapeHtml(latest.note)}` : ''} กรุณาตรวจสอบยอดในซอง/สลิปแล้วแจ้งใหม่
      </div>`;
    }
  }

  const historyRows = data.topups.length
    ? data.topups
        .map(
          (t) => `<tr>
            <td class="t-nowrap">${formatDate(t.createdAt)}</td>
            <td>${t.method === 'envelope' ? 'ซองทรู' : 'โอนธนาคาร'}</td>
            <td class="t-right">${money(t.amount)}</td>
            <td class="t-right" style="color:#ffb3bd">-${money(t.fee)}</td>
            <td class="t-right" style="color:#7ff0b5;font-weight:700">${money(t.net)}</td>
            <td>${statusPill(t.status)}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty-state">ยังไม่มีประวัติการเติมเงิน</div></td></tr>`;

  setPage(`
    <div class="page">
      <div class="section-head">
        <div>
          <h2 class="page-title">เติมเงินเข้าระบบ</h2>
          <p>เลือกช่องทาง เติมเครดิตเข้าบัญชี — ระบบหักค่าธรรมเนียม ${cfg.feePercent}% และแสดงยอดรับจริงทุกครั้ง</p>
        </div>
        <div class="balance-chip">เครดิตคงเหลือ ${money(state.me.balance)}</div>
      </div>

      ${statusBanner}

      <div class="two-col">
        <div class="card">
          <div class="chips" style="margin-bottom:16px">
            <button class="chip ${method === 'envelope' ? 'active' : ''}" data-method="envelope">🎁 ซองทรู (อั่งเปา)</button>
            <button class="chip ${method === 'bank' ? 'active' : ''}" data-method="bank">🏦 โอนธนาคาร</button>
          </div>
          <div id="method-info"></div>
          <div class="divider"></div>
          <div id="topup-form-wrap">${topupFormHtml(method)}</div>
        </div>

        <div class="card">
          <h3 class="card-title">รายละเอียดการรับเงิน</h3>
          <div class="kv"><span>เบอร์รับซองทรู</span><span class="mono">${escapeHtml(pay.ticketPhone || '-')}</span></div>
          <div class="kv"><span>ธนาคาร</span><span>${escapeHtml(pay.bank?.name || '-')}</span></div>
          <div class="kv"><span>เลขบัญชี</span><span class="mono">${escapeHtml(pay.bank?.account || '-')}</span></div>
          <div class="kv"><span>ชื่อบัญชี</span><span>${escapeHtml(pay.bank?.holder || '-')}</span></div>
          <div class="kv"><span>ค่าธรรมเนียม</span><span>${cfg.feePercent}% ต่อรายการ</span></div>
          <div class="note-box" style="margin-top:14px">
            ${escapeHtml(pay.note || '')}
          </div>
          <div class="lock-note" style="margin-top:11px">🔒 ข้อมูลนี้แสดงเฉพาะผู้ที่เข้าสู่ระบบแล้วเท่านั้น</div>
        </div>
      </div>

      <section class="section">
        <div class="section-head"><div><h2>ประวัติการเติมเงิน</h2><p>แสดงยอดที่ได้รับและค่าธรรมเนียมที่หักทุกครั้ง</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>วันที่</th><th>ช่องทาง</th><th class="t-right">ยอดแจ้ง</th><th class="t-right">หัก ${cfg.feePercent}%</th><th class="t-right">รับจริง</th><th>สถานะ</th></tr></thead>
            <tbody>${historyRows}</tbody>
          </table>
        </div>
      </section>
    </div>
  `);

  const renderMethod = () => {
    const info = document.getElementById('method-info');
    if (method === 'envelope') {
      info.innerHTML = `
        <div class="field" style="gap:8px">
          <label>เบอร์รับซองทรู (ล็อกโดยระบบ)</label>
          <div class="copy-box locked">
            <span>${escapeHtml(pay.ticketPhone || '-')}</span>
            <button type="button" data-copy="${escapeHtml(pay.ticketPhone || '')}">คัดลอก</button>
          </div>
          <div class="lock-note">🔒 ระบบอนุญาตให้รับซองที่เบอร์นี้เท่านั้น ห้ามแอดหรือเพิ่มเบอร์อื่น — เบอร์นี้ถูกล็อกและแก้ไขไม่ได้</div>
        </div>`;
    } else {
      info.innerHTML = `
        <div class="field" style="gap:8px">
          <label>บัญชีรับโอน (แอดมินตั้งค่าเอง)</label>
          <div class="copy-box">
            <span>${escapeHtml(pay.bank?.name || '-')} · ${escapeHtml(pay.bank?.account || '-')}</span>
            <button type="button" data-copy="${escapeHtml((pay.bank?.account || '').replace(/\D/g, ''))}">คัดลอก</button>
          </div>
          <div class="field-hint">ชื่อบัญชี: ${escapeHtml(pay.bank?.holder || '-')} — โอนแล้วกรอกเลขอ้างอิงด้านล่าง</div>
        </div>`;
    }
  };

  const bindForm = () => {
    const form = document.querySelector('[data-form="topup"]');
    const amountInput = form.amount;
    const preview = {
      amount: form.querySelector('[data-fee-amount]'),
      fee: form.querySelector('[data-fee-fee]'),
      net: form.querySelector('[data-fee-net]'),
    };
    const recalc = () => {
      const amount = Math.max(0, Number(amountInput.value) || 0);
      const fee = Math.round(amount * cfg.feePercent) / 100;
      preview.amount.textContent = money(amount);
      preview.fee.textContent = '-' + money(fee);
      preview.net.textContent = money(amount - fee);
    };
    amountInput.addEventListener('input', recalc);
    recalc();

    form.querySelectorAll('[data-amount]').forEach((btn) => {
      btn.addEventListener('click', () => {
        amountInput.value = btn.dataset.amount;
        recalc();
      });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorEl = form.querySelector('[data-error]');
      const submit = form.querySelector('[data-submit]');
      errorEl.textContent = '';
      submit.disabled = true;
      submit.textContent = 'กำลังส่งข้อมูล…';
      try {
        const res = await api('/topups', {
          method: 'POST',
          body: {
            method,
            amount: Number(amountInput.value),
            reference: form.reference.value.trim(),
            note: form.note.value.trim(),
          },
        });
        toast(res.message, 'success', 6000);
        await renderTopup();
      } catch (err) {
        errorEl.textContent = err.message;
        submit.disabled = false;
        submit.textContent = 'แจ้งเติมเงิน';
      }
    });
  };

  renderMethod();
  bindForm();

  document.querySelectorAll('[data-method]').forEach((btn) => {
    btn.addEventListener('click', () => {
      method = btn.dataset.method;
      document.querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('topup-form-wrap').innerHTML = topupFormHtml(method);
      renderMethod();
      bindForm();
    });
  });
}

/* ------------------------------------------------------------------ */
/* account                                                             */
/* ------------------------------------------------------------------ */

async function renderAccount() {
  setRoute('account');
  if (!state.me) {
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let orders = [];
  let tickets = [];
  try {
    const [ordersRes, ticketsRes] = await Promise.all([api('/orders'), api('/tickets')]);
    orders = ordersRes.orders;
    tickets = ticketsRes.tickets;
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }

  const orderRows = orders.length
    ? orders
        .map(
          (o) => `<tr>
            <td class="t-nowrap">${formatDate(o.createdAt)}</td>
            <td>${escapeHtml(o.productName)}</td>
            <td class="t-right">${o.quantity}</td>
            <td class="t-right">${money(o.unitPrice)}</td>
            <td class="t-right" style="font-weight:600">${money(o.total)}</td>
            <td>${codesHtml(o.codes)}</td>
            <td>${statusPill(o.status)}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="7"><div class="empty-state">ยังไม่มีคำสั่งซื้อ</div></td></tr>`;

  const ticketRows = tickets.length
    ? tickets
        .map(
          (t) => `<div class="list-row" style="align-items:flex-start">
            <div>
              <strong>${escapeHtml(t.subject)}</strong>
              <div class="tiny muted">${formatDate(t.created_at)}</div>
              <div class="small" style="margin-top:4px">${escapeHtml(t.message)}</div>
              ${
                t.reply
                  ? `<div class="small" style="margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(47,208,127,.08);border:1px solid rgba(47,208,127,.2);color:#a8f5ca">แอดมิน: ${escapeHtml(t.reply)}</div>`
                  : ''
              }
            </div>
            ${statusPill(t.status)}
          </div>`,
        )
        .join('')
    : `<div class="empty-state">ยังไม่มีเรื่องที่แจ้งไว้</div>`;

  setPage(`
    <div class="page">
      <div class="section-head"><div><h2 class="page-title">บัญชีของฉัน</h2><p>ข้อมูลบัญชี คำสั่งซื้อ และประวัติซัพพอร์ต</p></div></div>
      <div class="two-col">
        <div class="card">
          <div class="row between wrap">
            <div class="row">
              <span class="avatar" style="width:46px;height:46px;font-size:17px">${escapeHtml(state.me.username.slice(0, 1).toUpperCase())}</span>
              <div>
                <h3 class="card-title-lg">${escapeHtml(state.me.username)}</h3>
                <div style="margin-top:4px">${roleBadge(state.me.role, state.me.roleLabel)}</div>
              </div>
            </div>
            <div class="balance-chip">💰 ${money(state.me.balance)}</div>
          </div>
          <div class="divider"></div>
          <div class="kv"><span>ช่องทางติดต่อ</span><span>${escapeHtml(state.me.contact || '-')}</span></div>
          <div class="kv"><span>สมัครเมื่อ</span><span>${formatDate(state.me.createdAt)}</span></div>
          <div class="kv"><span>สิทธิ์การใช้งาน</span><span>${
            state.me.role === 'dealer'
              ? 'ซื้อคีย์ราคาตัวแทน ลด ' + state.config.dealerDiscount + '%'
              : state.me.rank <= 2
                ? 'จัดการหลังบ้าน + ซัพพอร์ต'
                : 'ซื้อสินค้า / เติมเงิน'
          }</span></div>
          <div class="row wrap" style="margin-top:16px">
            <a class="btn btn-primary btn-sm" href="#/topup">เติมเงิน</a>
            <a class="btn btn-ghost btn-sm" href="#/topup">ประวัติการเติมเงิน</a>
            <a class="btn btn-ghost btn-sm" href="#/reseller">สมัคร/จัดการตัวแทน</a>
            <a class="btn btn-ghost btn-sm" href="#/support">แจ้งปัญหา</a>
            <a class="btn btn-ghost btn-sm" href="#/">กลับร้านค้า</a>
          </div>
        </div>
        <div class="card">
          <h3 class="card-title">ซัพพอร์ตของฉัน</h3>
          <div style="margin-top:8px">${ticketRows}</div>
        </div>
      </div>

      <section class="section">
        <div class="section-head"><div><h2>ประวัติการซื้อ / คีย์ของฉัน</h2><p>ทั้งหมด ${orders.length} รายการ — คัดลอกคีย์ซ้ำได้ทุกเมื่อ</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>วันที่</th><th>สินค้า</th><th class="t-right">จำนวน</th><th class="t-right">ราคา/ชิ้น</th><th class="t-right">รวม</th><th>คีย์ที่ได้รับ</th><th>สถานะ</th></tr></thead>
            <tbody>${orderRows}</tbody>
          </table>
        </div>
      </section>
    </div>
  `);
}

/* ------------------------------------------------------------------ */
/* support                                                             */
/* ------------------------------------------------------------------ */

async function renderSupport() {
  setRoute('support');
  if (!state.me) {
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let tickets = [];
  try {
    tickets = (await api('/tickets')).tickets;
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }
  const list = tickets.length
    ? tickets
        .map(
          (t) => `<div class="list-row" style="align-items:flex-start">
        <div>
          <strong>${escapeHtml(t.subject)}</strong>
          <div class="tiny muted">${formatDate(t.created_at)}</div>
          <div class="small" style="margin-top:4px">${escapeHtml(t.message)}</div>
          ${t.reply ? `<div class="small" style="margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(47,208,127,.08);border:1px solid rgba(47,208,127,.2);color:#a8f5ca">แอดมิน: ${escapeHtml(t.reply)}</div>` : ''}
        </div>
        ${statusPill(t.status)}
      </div>`,
        )
        .join('')
    : `<div class="empty-state">ยังไม่มีเรื่องที่แจ้งไว้</div>`;

  setPage(`
    <div class="page">
      <div class="section-head"><div><h2 class="page-title">ซัพพอร์ต</h2><p>แจ้งปัญหาเรื่องคีย์ เติมเงิน หรือการใช้งาน — แอดมินจะตอบกลับในระบบ</p></div></div>
      <div class="discord-banner">
        <div><strong>เข้าร่วมกับเราได้ที่ Discord</strong><div class="tiny muted">ถามตอบเร็ว ประกาศโปรโมชั่น และอัปเดตสต็อกคีย์ก่อนใคร</div></div>
        ${discordButton('btn btn-discord')}
      </div>
      <div class="two-col">
        <div class="card">
          <h3 class="card-title">แจ้งเรื่องใหม่</h3>
          <form data-form="ticket" class="stack" style="margin-top:12px" novalidate>
            <div class="field"><label>หัวข้อ</label><input class="input" name="subject" maxlength="80" required placeholder="เช่น คีย์ใช้งานไม่ได้" /></div>
            <div class="field"><label>รายละเอียด</label><textarea class="textarea" name="message" maxlength="1000" required placeholder="อธิบายปัญหาของคุณ พร้อมเลขออเดอร์ถ้ามี"></textarea></div>
            <div class="form-error" data-error></div>
            <button class="btn btn-primary" type="submit" data-submit>ส่งเรื่องถึงแอดมิน</button>
          </form>
        </div>
        <div class="card">
          <h3 class="card-title">เรื่องที่แจ้งไว้</h3>
          <div style="margin-top:8px">${list}</div>
        </div>
      </div>
    </div>
  `);

  const form = document.querySelector('[data-form="ticket"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = form.querySelector('[data-error]');
    const submit = form.querySelector('[data-submit]');
    errorEl.textContent = '';
    submit.disabled = true;
    try {
      const res = await api('/tickets', {
        method: 'POST',
        body: { subject: form.subject.value.trim(), message: form.message.value.trim() },
      });
      toast(res.message, 'success');
      await renderSupport();
    } catch (err) {
      errorEl.textContent = err.message;
      submit.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* reseller / ตัวแทนตัวขาย + API                                        */
/* ------------------------------------------------------------------ */

function progressHtml(value, target) {
  const pct = Math.min(100, Math.max(0, Math.round((Number(value) / target) * 100)));
  return `<div class="progress"><span style="width:${pct}%"></span></div>`;
}

function resellerRulesHtml(rules) {
  return `
    <div class="kv"><span>ค่าบริการรายเดือน</span><span>${money(rules.fee)}</span></div>
    <div class="kv"><span>เป้ายอดขายสัปดาห์</span><span>${money(rules.weeklyTarget)}</span></div>
    <div class="kv"><span>เป้ายอดขายเดือน</span><span>${money(rules.monthlyTarget)}</span></div>
    <div class="kv"><span>ราคาพิเศษสำหรับตัวแทน</span><span>ลด ${state.config.dealerDiscount}%</span></div>`;
}

function resellerApplyHtml(data, noteText) {
  return `
    <div class="two-col">
      <div class="card">
        <h3 class="card-title-lg">เงื่อนไขการเป็นตัวแทน/ตัวขาย</h3>
        <div style="margin-top:10px">${resellerRulesHtml(data.rules)}</div>
        <div class="note-box" style="margin-top:14px">
          ต้องขายให้ได้ ${money(data.rules.weeklyTarget)}/สัปดาห์ และ ${money(data.rules.monthlyTarget)}/เดือน
          — หากรอบ 1 เดือน (${data.rules.trialDays} วัน) ยอดขายไม่ถึง ${money(data.rules.monthlyTarget)}
          ระบบจะปลดจากยศตัวแทนเป็น member และยกเลิก API key ทั้งหมดอัตโนมัติ
        </div>
        ${noteText ? `<div class="warn-banner" style="margin-top:12px">${escapeHtml(noteText)}</div>` : ''}
      </div>
      <div class="card">
        <h3 class="card-title-lg">สมัครเป็นตัวแทน/ตัวขาย</h3>
        <p class="small muted" style="margin:6px 0 14px">
          เมื่อแอดมินอนุมัติ ระบบจะหักค่าบริการ ${money(data.rules.fee)} จากเครดิตของคุณและเปิดใช้งาน API ซื้อคีย์ทันที
        </p>
        <form data-form="reseller" class="stack" novalidate>
          <div class="field"><label>ช่องทางติดต่อ (LINE / เบอร์โทร)</label>
            <input class="input" name="contact" maxlength="60" required value="${escapeHtml(state.me.contact || '')}" placeholder="เช่น line: firekey_seller" /></div>
          <div class="field"><label>แนะนำตัว / ช่องทางขาย (ไม่บังคับ)</label>
            <textarea class="textarea" name="note" maxlength="200" placeholder="เช่น ขายผ่านเพจ Facebook มีลูกค้าประจำ"></textarea></div>
          <label class="checkbox-row"><input type="checkbox" name="agree" /> ยอมรับเงื่อนไข: ขายให้ได้ ${money(data.rules.weeklyTarget)}/สัปดาห์, จ่ายค่าบริการ ${money(data.rules.fee)}/เดือน และถ้ายอดขาย 1 เดือนไม่ถึง ${money(data.rules.monthlyTarget)} จะถูกปลด</label>
          <div class="form-error" data-error></div>
          <button class="btn btn-primary btn-block" type="submit" data-submit>ส่งใบสมัครตัวแทน</button>
        </form>
      </div>
    </div>`;
}

async function renderReseller() {
  setRoute('reseller');
  if (!state.me) {
    toast('กรุณาเข้าสู่ระบบก่อนสมัครตัวแทน', 'info');
    location.hash = '#/login';
    return;
  }
  setPage(loader());
  let data;
  try {
    data = await api('/reseller');
  } catch (err) {
    setPage(errorState(err.message));
    return;
  }
  state.me = data.user || state.me;

  if (!data.canApply && ['none', 'rejected', 'revoked'].includes(data.status)) {
    setPage(`
      <div class="page">
        <div class="section-head"><div><h2 class="page-title">ตัวแทน / ตัวขาย</h2>
          <p>บัญชีนี้ไม่ต้องสมัครตัวแทน (แอดมิน/Owner) — จัดการใบสมัครได้ที่หลังบ้าน</p></div></div>
        <div class="card">
          <h3 class="card-title-lg">จัดการตัวแทนที่หลังบ้าน</h3>
          <p class="small muted" style="margin:8px 0 14px">อนุมัติ/ปลดตัวแทน ดูเป้ายอดขาย และจำนวน API key ของแต่ละคนได้ในแท็บ “ตัวแทน &amp; API”</p>
          <a class="btn btn-primary" href="#/admin?tab=resellers">ไปที่หลังบ้าน</a>
        </div>
      </div>`);
    return;
  }

  if (data.status === 'none' || data.status === 'rejected' || data.status === 'revoked') {
    const noteText =
      data.status === 'revoked'
        ? `บัญชีนี้ถูกปลดจากยศตัวแทนแล้ว: ${data.profile?.reviewNote || 'ยอดขายไม่ถึงเป้า'} — สมัครใหม่ได้เมื่อพร้อม`
        : data.status === 'rejected'
          ? `ใบสมัครก่อนหน้าไม่ผ่าน: ${data.profile?.reviewNote || '-'}`
          : '';
    setPage(`
      <div class="page">
        <div class="section-head"><div><h2 class="page-title">ตัวแทน / ตัวขาย</h2>
          <p>สมัครเป็นตัวแทน ซื้อคีย์ราคาลด ${state.config.dealerDiscount}% และเรียกซื้อผ่าน API ได้</p></div></div>
        ${resellerApplyHtml(data, noteText)}
      </div>`);
    const form = document.querySelector('[data-form="reseller"]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorEl = form.querySelector('[data-error]');
      const submit = form.querySelector('[data-submit]');
      errorEl.textContent = '';
      if (!form.agree.checked) {
        errorEl.textContent = 'กรุณายอมรับเงื่อนไขก่อนสมัคร';
        return;
      }
      submit.disabled = true;
      submit.textContent = 'กำลังส่งใบสมัคร…';
      try {
        const res = await api('/reseller/apply', {
          method: 'POST',
          body: {
            contact: form.contact.value.trim(),
            note: form.note.value.trim(),
            agree: true,
          },
        });
        toast(res.message, 'success', 6000);
        await renderReseller();
      } catch (err) {
        errorEl.textContent = err.message;
        submit.disabled = false;
        submit.textContent = 'ส่งใบสมัครตัวแทน';
      }
    });
    return;
  }

  if (data.status === 'pending') {
    setPage(`
      <div class="page">
        <div class="section-head"><div><h2 class="page-title">ตัวแทน / ตัวขาย</h2>
          <p>ใบสมัครของคุณถูกส่งถึงแอดมินแล้ว</p></div>${statusPill('pending')}</div>
        <div class="card">
          <h3 class="card-title-lg">รอแอดมินอนุมัติ</h3>
          <p class="small muted" style="margin:8px 0 14px">
            เมื่ออนุมัติ ระบบจะหักค่าบริการ ${money(data.rules.fee)} จากเครดิต เปิดยศตัวแทน (ราคาลด ${state.config.dealerDiscount}%) และปลดล็อก API ซื้อคีย์
          </p>
          <div>${resellerRulesHtml(data.rules)}</div>
        </div>
      </div>`);
    return;
  }

  const suspended = data.status === 'suspended';
  const keysRows = data.keys.length
    ? data.keys
        .map(
          (k) => `<div class="list-row" style="align-items:flex-start">
            <div><strong>${escapeHtml(k.name)}</strong>
              <div class="tiny mono muted">${escapeHtml(k.prefix)}</div>
              <div class="tiny muted">สร้าง ${formatDate(k.created_at)} · ใช้ล่าสุด ${k.last_used_at ? formatDate(k.last_used_at) : 'ยังไม่เคยใช้'}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-revoke-key="${k.id}">ยกเลิก</button>
          </div>`,
        )
        .join('')
    : `<div class="empty-state">ยังไม่มี API key — สร้างคีย์ด้านบนเพื่อเริ่มเรียก API</div>`;

  const origin = location.origin;
  setPage(`
    <div class="page">
      <div class="section-head">
        <div><h2 class="page-title">ตัวแทน / ตัวขาย</h2><p>ติดตามเป้ายอดขาย จ่ายค่าบริการรายเดือน และเรียกซื้อคีย์ผ่าน API</p></div>
        ${roleBadge(state.me.role, state.me.roleLabel)}
      </div>
      ${suspended ? `<div class="warn-banner">⚠ สถานะตัวแทนถูกระงับ: ${escapeHtml(data.profile?.reviewNote || 'ค้างชำระค่าบริการ')} — ชำระค่าบริการเพื่อเปิดใช้งาน API อีกครั้ง</div>` : ''}
      <div class="stat-grid">
        <div class="stat-card"><div class="label">ยอดขาย 7 วัน</div><div class="value">${money(data.sales.weekly)}</div><div class="hint">เป้า ${money(data.rules.weeklyTarget)} / สัปดาห์</div></div>
        <div class="stat-card"><div class="label">ยอดขาย 30 วัน</div><div class="value">${money(data.sales.monthly)}</div><div class="hint">เป้า ${money(data.rules.monthlyTarget)} / เดือน</div></div>
        <div class="stat-card"><div class="label">ค่าบริการถัดไป</div><div class="value">${money(data.rules.fee)}</div><div class="hint">${data.daysLeft ? `เหลือ ${data.daysLeft} วัน` : 'ต้องชำระ'}</div></div>
        <div class="stat-card"><div class="label">API key ที่ใช้งาน</div><div class="value">${data.keys.length}</div><div class="hint">สูงสุด 5 คีย์</div></div>
      </div>

      <div class="two-col" style="margin-top:18px">
        <div class="stack">
          <div class="card">
            <h3 class="card-title-lg">เป้ายอดขาย</h3>
            <div class="kv"><span>สัปดาห์นี้</span><span>${money(data.sales.weekly)} / ${money(data.rules.weeklyTarget)}</span></div>
            ${progressHtml(data.sales.weekly, data.rules.weeklyTarget)}
            <div class="kv" style="margin-top:12px"><span>เดือนนี้ (30 วัน)</span><span>${money(data.sales.monthly)} / ${money(data.rules.monthlyTarget)}</span></div>
            ${progressHtml(data.sales.monthly, data.rules.monthlyTarget)}
            <p class="tiny muted" style="margin-top:12px">
              รอบประเมิน ${data.rules.trialDays} วัน · หากยอดขาย 30 วันต่ำกว่า ${money(data.rules.monthlyTarget)}
              ระบบจะปลดยศตัวแทนและยกเลิก API key อัตโนมัติ
            </p>
          </div>

          <div class="card">
            <div class="row between wrap">
              <h3 class="card-title-lg">API ซื้อคีย์</h3>
              <button class="btn btn-sm btn-primary" data-new-key ${data.apiEnabled ? '' : 'disabled'}>+ สร้าง API key</button>
            </div>
            <p class="small muted" style="margin:6px 0 10px">ใช้ API key แนบ header แล้วเรียกซื้อคีย์ได้ทันที ระบบตัดเครดิตและส่งคีย์กลับในคำตอบเดียว</p>
            <pre class="api-doc">GET  ${origin}/api/v1/products
Authorization: Bearer &lt;API_KEY&gt;

POST ${origin}/api/v1/purchase
Authorization: Bearer &lt;API_KEY&gt;
Content-Type: application/json

{ "productId": 1, "quantity": 1 }</pre>
            <div style="margin-top:10px">${keysRows}</div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h3 class="card-title-lg">ค่าบริการรายเดือน</h3>
            <div class="kv"><span>ค่าบริการ</span><span>${money(data.rules.fee)} / 30 วัน</span></div>
            <div class="kv"><span>ชำระถึง</span><span>${data.profile?.feePaidUntil ? formatDate(data.profile.feePaidUntil) : '-'}</span></div>
            <div class="kv"><span>เครดิตคงเหลือ</span><span>${money(state.me.balance)}</span></div>
            <button class="btn btn-primary btn-block" data-renew style="margin-top:14px">ชำระ ${money(data.rules.fee)} ต่ออายุ 30 วัน</button>
            <p class="tiny muted" style="margin-top:8px">ระบบหักจากเครดิตในบัญชี — ถ้าไม่พอให้เติมเงินก่อน</p>
          </div>
          <div class="card">
            <h3 class="card-title-lg">สิทธิ์ตัวแทน</h3>
            <div style="margin-top:10px">${resellerRulesHtml(data.rules)}</div>
            ${data.profile?.startedAt ? `<div class="kv"><span>เริ่มเป็นตัวแทน</span><span>${formatDate(data.profile.startedAt)}</span></div>` : ''}
          </div>
        </div>
      </div>
    </div>`);

  const renewBtn = document.querySelector('[data-renew]');
  if (renewBtn)
    renewBtn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'ชำระค่าบริการตัวแทน',
        message: `หัก ${money(data.rules.fee)} จากเครดิตเพื่อต่ออายุ 30 วัน ใช่หรือไม่`,
        confirmText: 'ชำระค่าบริการ',
      });
      if (!ok) return;
      renewBtn.disabled = true;
      try {
        const res = await api('/reseller/renew', { method: 'POST' });
        toast(res.message, 'success', 5000);
        await refreshMe();
        await renderReseller();
      } catch (err) {
        toast(err.message, 'error');
        renewBtn.disabled = false;
      }
    });

  const newKeyBtn = document.querySelector('[data-new-key]');
  if (newKeyBtn)
    newKeyBtn.addEventListener('click', () => {
      const modal = openModal(`
        <h3>สร้าง API key</h3>
        <p class="modal-sub">ตั้งชื่อเพื่อจำง่าย เช่น “ร้านคู่ค้า A” — คีย์เต็มจะแสดงครั้งเดียว</p>
        <div class="field"><label>ชื่อคีย์</label>
          <input class="input" data-key-name maxlength="40" placeholder="API key สำหรับขายส่ง" value="API key" /></div>
        <div class="form-error" data-error></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-cancel>ยกเลิก</button>
          <button class="btn btn-primary" data-create>สร้างคีย์</button>
        </div>`);
      modal.overlay.querySelector('[data-cancel]').addEventListener('click', modal.close);
      modal.overlay.querySelector('[data-create]').addEventListener('click', async () => {
        const errorEl = modal.overlay.querySelector('[data-error]');
        const btn = modal.overlay.querySelector('[data-create]');
        errorEl.textContent = '';
        btn.disabled = true;
        try {
          const res = await api('/reseller/keys', {
            method: 'POST',
            body: { name: modal.overlay.querySelector('[data-key-name]').value.trim() || 'API key' },
          });
          modal.close();
          const show = openModal(`
            <h3>✅ สร้าง API key แล้ว</h3>
            <p class="modal-sub">คัดลอกและเก็บคีย์นี้ไว้ ระบบแสดงเต็มเพียงครั้งเดียว</p>
            <div class="copy-box"><span class="mono">${escapeHtml(res.key)}</span>
              <button type="button" data-copy="${escapeHtml(res.key)}">คัดลอก</button></div>
            <div class="note-box" style="margin-top:12px">${escapeHtml(res.message)}</div>
            <div class="modal-actions"><button class="btn btn-primary" data-close>ปิด</button></div>`);
          show.overlay.querySelector('[data-close]').addEventListener('click', show.close);
          await renderReseller();
        } catch (err) {
          errorEl.textContent = err.message;
          btn.disabled = false;
        }
      });
    });

  document.querySelectorAll('[data-revoke-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'ยกเลิก API key',
        message: 'หลังยกเลิก คีย์นี้จะเรียก API ไม่ได้ทันที ต้องการดำเนินการต่อหรือไม่',
        confirmText: 'ยกเลิกคีย์',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        const res = await api(`/reseller/keys/${btn.dataset.revokeKey}`, { method: 'DELETE' });
        toast(res.message, 'info');
        await renderReseller();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* หน้าเนื้อหา (About / Contact / FAQ / Terms / Privacy)              */
/* ------------------------------------------------------------------ */

async function renderInfo(page) {
  setRoute(page);
  const contact = `
    <div class="info-actions">
      ${discordButton('btn btn-discord')}
      <a class="btn btn-ghost" href="#/support">เปิด Ticket ซัพพอร์ต</a>
    </div>`;
  const pages = {
    about: {
      title: 'เกี่ยวกับเรา',
      lead: `${BRAND} คือร้านจำหน่ายคีย์โปรแกรม Free Fire ที่เน้นความเร็ว ความปลอดภัย และความโปร่งใส`,
      body: `
        <p>${BRAND} KEY STORE เริ่มจากกลุ่มผู้เล่นที่ต้องการแหล่งซื้อคีย์ที่ไว้ใจได้ ระบบของเราออกแบบให้ส่งคีย์อัตโนมัติทันทีหลังชำระเงิน ทุกคีย์ถูกจัดเก็บแยกตามสินค้าและระยะเวลาใช้งาน และคีย์ที่ขายแล้วจะถูก ล็อกไม่ให้ขายซ้ำ</p>
        <p>เราให้ความสำคัญกับความปลอดภัยของบัญชีลูกค้า ใช้ระบบยืนยันตัวตนก่อนเข้าเว็บ จำกัดการยิงคำขอ และตรวจสอบธุรกรรมทุกครั้งที่ฝั่งเซิร์ฟเวอร์</p>
        <div class="info-stats">
          <div><strong>24/7</strong><span>ส่งคีย์อัตโนมัติ</span></div>
          <div><strong>3%</strong><span>ค่าธรรมเนียมเติมเงิน</span></div>
          <div><strong>35%</strong><span>ส่วนลดตัวแทน</span></div>
        </div>`,
    },
    contact: {
      title: 'ติดต่อร้าน',
      lead: 'ช่องทางติดต่ออย่างเป็นทางการของ VEXIS KEY STORE',
      body: `
        <p>สอบถามสินค้า แจ้งปัญหา หรือติดตามสถานะคำสั่งซื้อได้ผ่านช่องทางด้านล่าง ทีมงานตอบกลับทุกวัน</p>
        <div class="info-list">
          <div class="info-row"><span>💬 Discord</span><a href="${discordUrl()}" target="_blank" rel="noopener noreferrer">เข้าร่วมเซิร์ฟเวอร์ Discord</a></div>
          <div class="info-row"><span>🎫 Ticket ในเว็บ</span><a href="#/support">เปิด Ticket ซัพพอร์ต</a></div>
          <div class="info-row"><span>🕒 เวลาทำการ</span><span>ทุกวัน 24 ชั่วโมง</span></div>
          <div class="info-row"><span>💳 ข้อมูลรับเงิน</span><span>แสดงเฉพาะผู้ที่เข้าสู่ระบบแล้วเท่านั้น</span></div>
        </div>
        ${contact}`,
    },
    faq: {
      title: 'คำถามที่พบบ่อย',
      lead: 'รวมคำตอบสำหรับคำถามยอดนิยมก่อนสั่งซื้อ',
      body: `
        <details class="faq"><summary>ซื้อแล้วได้คีย์เมื่อไหร่?</summary><p>ทันที ระบบตัดเครดิตและดึงคีย์จากคลังส่งให้อัตโนมัติหลังยืนยันคำสั่งซื้อ คีย์จะแสดงในหน้าต่างยืนยันและบันทึกใน “ประวัติการซื้อ”</p></details>
        <details class="faq"><summary>เติมเงินอย่างไร และหักค่าธรรมเนียมเท่าไหร่?</summary><p>เติมผ่านซองทรูหรือโอนธนาคาร แจ้งยอดและหลักฐานในหน้าเติมเงิน แอดมินตรวจสอบแล้วเติมเครดิตให้ ระบบหักค่าธรรมเนียม ${state.config ? state.config.feePercent : 3}% จากยอดที่ได้รับ</p></details>
        <details class="faq"><summary>ถ้าสต็อกคีย์หมดจะเกิดอะไรขึ้น?</summary><p>ระบบจะปิดการขายสินค้านั้นทันทีและไม่ตัดเงินคุณ จนกว่าแอดมินจะเพิ่มคีย์จริงเข้าคลัง</p></details>
        <details class="faq"><summary>เป็นตัวแทนต้องทำอย่างไร?</summary><p>สมัครที่หน้าตัวแทน/API ระบบให้ส่วนลด 35% โดยต้องมียอดขาย ${'250'} บาท/สัปดาห์, ${'30'} ออเดอร์/เดือน และไม่ต่ำกว่า ${'650'} บาท/เดือน จึงจะคงสถานะตัวแทน</p></details>
        <details class="faq"><summary>คีย์ที่ซื้อไปแล้วคืนได้ไหม?</summary><p>เนื่องจากเป็นสินค้าดิจิทัลที่ส่งทันที จึงไม่สามารถคืนหรือเปลี่ยนได้ ยกเว้นกรณีคีย์ใช้งานไม่ได้จริงจากระบบ</p></details>
        ${contact}`,
    },
    terms: {
      title: 'เงื่อนไขการใช้บริการ',
      lead: 'โปรดอ่านก่อนสมัครสมาชิกและทำธุรกรรมกับร้าน',
      body: `
        <h3>1. การสมัครสมาชิก</h3><p>ผู้ใช้ต้องให้ข้อมูลที่ถูกต้องและไม่แชร์บัญชีให้ผู้อื่น ระบบอาจระงับบัญชีที่พบการใช้งานผิดปกติ</p>
        <h3>2. เครดิตและการเติมเงิน</h3><p>เครดิตใช้ได้เฉพาะภายในร้าน ไม่สามารถถอนเป็นเงินสดได้ และระบบหักค่าธรรมเนียม ${state.config ? state.config.feePercent : 3}% จากยอดเติมเงิน</p>
        <h3>3. การส่งมอบคีย์</h3><p>คีย์ถูกส่งอัตโนมัติหลังชำระเงิน และไม่สามารถขาย/ส่งซ้ำได้ กรุณาเก็บคีย์ไว้อย่างปลอดภัย</p>
        <h3>4. การคืนเงิน</h3><p>สินค้าดิจิทัลที่ส่งมอบแล้วไม่สามารถคืนได้ ยกเว้นคีย์มีปัญหาจากฝ่ายร้าน</p>
        <h3>5. สถานะตัวแทน</h3><p>ตัวแทนได้ส่วนลด 35% และต้องรักษายอดขายตามเงื่อนไข มิฉะนั้นระบบอาจปลดสถานะและยกเลิก API key</p>`,
    },
    privacy: {
      title: 'นโยบายความเป็นส่วนตัว',
      lead: 'เราเก็บข้อมูลเท่าที่จำเป็นและปกป้องข้อมูลรับเงินของคุณ',
      body: `
        <h3>ข้อมูลที่เก็บ</h3><p>ชื่อผู้ใช้ รหัสผ่านแบบเข้ารหัส ช่องทางติดต่อ (ถ้าผู้ใช้กรอก) ประวัติคำสั่งซื้อและประวัติเติมเงิน</p>
        <h3>ข้อมูลที่ไม่เปิดเผยต่อสาธารณะ</h3><p>เบอร์รับเงิน บัญชีธนาคาร และข้อมูลการชำระเงิน แสดงเฉพาะผู้ที่เข้าสู่ระบบแล้วเท่านั้น และไม่ถูกส่งต่อให้บุคคลภายนอก</p>
        <h3>ความปลอดภัย</h3><p>ระบบตรวจสอบสิทธิ์ฝั่งเซิร์ฟเวอร์ทุกครั้ง ใช้คุกกี้เซสชันแบบลงนาม จำกัดการยิงคำขอ และบันทึกประวัติการทำงานของผู้ดูแล</p>
        <h3>การติดต่อ</h3><p>หากต้องการแก้ไขหรือลบข้อมูลส่วนตัว ติดต่อทีมงานผ่าน Ticket หรือ Discord</p>`,
    },
  };
  const info = pages[page] || pages.about;
  setPage(`
    <div class="page">
      <article class="card info-card">
        <h1 class="page-title">${info.title}</h1>
        <p class="info-lead">${info.lead}</p>
        <div class="info-body">${info.body}</div>
        <div class="info-actions"><a class="btn btn-ghost" href="#/">กลับไปหน้าร้านค้า</a></div>
      </article>
    </div>`);
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  return raw.split('?')[0].replace(/\/+$/, '');
}

async function route() {
  const path = currentRoute();
  closeMobileMenu();
  window.scrollTo(0, 0);
  try {
    if (path === '') return await renderHome();
    if (path === 'login') return await renderLogin();
    if (path === 'register') return await renderRegister();
    if (path === 'topup') return await renderTopup();
    if (path === 'account') return await renderAccount();
    if (path === 'reseller') return await renderReseller();
    if (path === 'support') return await renderSupport();
    if (['about', 'contact', 'faq', 'terms', 'privacy'].includes(path)) return await renderInfo(path);
    if (path === 'admin') {
      if (!state.me) {
        location.hash = '#/login';
        return;
      }
      if (!isStaff()) {
        toast('คุณไม่มีสิทธิ์เข้าหลังบ้าน', 'error');
        location.hash = '#/';
        return;
      }
      const { renderAdmin } = await import('./admin.js?v=11');
      return await renderAdmin({ app, state, shell, setPage, refreshMe, updateBalanceChip, loader, errorState });
    }
    return await renderHome();
  } catch (err) {
    setPage(errorState(err.message || 'ไม่สามารถโหลดหน้านี้ได้'));
  }
}

/* ------------------------------------------------------------------ */
/* global events                                                       */
/* ------------------------------------------------------------------ */

onUnauthorized(() => {
  if (state.me) {
    state.me = null;
    toast('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'error');
  }
});

document.addEventListener('click', async (event) => {
  const copyBtn = event.target.closest('[data-copy]');
  if (copyBtn) {
    await copyText(copyBtn.dataset.copy);
    return;
  }

  const catBtn = event.target.closest('[data-cat]');
  if (catBtn && state.store) {
    state.filter.category = Number(catBtn.dataset.cat);
    document.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('active', b === catBtn));
    paintProducts();
    return;
  }

  const buyBtn = event.target.closest('[data-buy]');
  if (buyBtn && state.store) {
    const product = state.store.products.find((p) => p.id === Number(buyBtn.dataset.buy));
    if (product) openBuyModal(product);
    return;
  }

  const actionBtn = event.target.closest('[data-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    if (action === 'toggle-menu') {
      toggleMobileMenu();
      return;
    }
    if (action === 'close-menu') {
      closeMobileMenu();
      return;
    }
    if (action === 'scroll-products') {
      const el = document.getElementById('category-chips');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (action === 'logout') {
      closeMobileMenu();
      try {
        await api('/auth/logout', { method: 'POST' });
      } catch {
        /* ignore */
      }
      state.me = null;
      state.store = null;
      toast('ออกจากระบบแล้ว', 'info');
      location.hash = '#/';
      await route();
      return;
    }
  }
});

window.addEventListener('hashchange', () => {
  route();
});

/* ------------------------------------------------------------------ */
/* ประตูยืนยันตัวตน (Captcha Gate) — ก่อนเข้าเว็บ                      */
/* ------------------------------------------------------------------ */

function gateLocalValid() {
  try {
    return Number(localStorage.getItem(GATE_KEY) || 0) > Date.now();
  } catch {
    return false;
  }
}

function markGatePassed() {
  try {
    localStorage.setItem(GATE_KEY, String(Date.now() + GATE_TTL_MS));
  } catch {
    /* โหมดส่วนตัวบางเบราว์เซอร์เขียนไม่ได้ — ใช้คุกกี้ฝั่งเซิร์ฟเวอร์แทน */
  }
}

async function showGate(message = '') {
  document.body.classList.add('gate-open');
  closeMobileMenu();
  app.innerHTML = `
    <div class="gate-screen">
      <div class="gate-halo"></div>
      <div class="gate-card">
        <span class="gate-badge">🛡️ PROTECTED STORE</span>
        <h1>ยืนยันตัวตนก่อนเข้าเว็บ</h1>
        <p class="gate-sub">${BRAND} KEY STORE ใช้ระบบตรวจสอบว่าไม่ใช่บอท เพื่อความปลอดภัยของลูกค้าและสต็อกคีย์ทุกใบ</p>
        <ul class="gate-points">
          <li><span>✅</span> ต้องผ่านแคปช่าก่อนดูสินค้าและสมัครสมาชิก</li>
          <li><span>🔒</span> ข้อมูลรับเงินแสดงเฉพาะผู้เข้าสู่ระบบ</li>
          <li><span>🚫</span> ระบบป้องกันการดึง/คัดลอกเนื้อหาทั้งเว็บ</li>
        </ul>
        <form data-form="gate" class="stack" novalidate>
          <div id="gate-captcha"></div>
          <div class="form-error" data-error>${escapeHtml(message)}</div>
          <button class="btn btn-primary btn-block" type="submit" data-submit>ยืนยันและเข้าเว็บ</button>
        </form>
        <div class="gate-foot">
          ${discordButton('discord-chip', 'เข้าร่วมกับเรา Discord')}
          <span class="tiny muted">ผ่านแล้วเข้าเว็บต่อเนื่อง 12 ชั่วโมง</span>
        </div>
      </div>
    </div>`;
  const slot = document.getElementById('gate-captcha');
  await mountCaptcha(slot, state.config);
  const form = document.querySelector('[data-form="gate"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = form.querySelector('[data-error]');
    const submit = form.querySelector('[data-submit]');
    errorEl.textContent = '';
    submit.disabled = true;
    submit.textContent = 'กำลังตรวจสอบ…';
    try {
      await api('/gate', { method: 'POST', body: { ...captchaPayload(slot) } });
      markGatePassed();
      document.body.classList.remove('gate-open');
      state.config = await api('/config');
      await refreshMe();
      await route();
      startLive();
    } catch (err) {
      errorEl.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'ยืนยันและเข้าเว็บ';
      await mountCaptcha(slot, state.config);
    }
  });
}

/* ------------------------------------------------------------------ */
/* อัปเดตเรียลไทม์ (สต็อก/ราคา/เครดิต/แจ้งเตือน)                     */
/* ------------------------------------------------------------------ */

const live = {
  timer: null,
  ready: false,
  userId: 0,
  lastOrderId: 0,
  lastStaffTopup: 0,
  lastStaffOrder: 0,
  lastTopupId: 0,
  lastTopupStatus: '',
  balance: 0,
  bound: false,
};

function setLiveChip(pending) {
  const chip = document.getElementById('live-chip');
  if (!chip) return;
  chip.textContent = pending ? `● ${pending} รอตรวจ` : '● LIVE';
  chip.classList.toggle('alert', Boolean(pending));
}

function applyLive(data) {
  const userId = state.me ? state.me.id : 0;
  if (live.userId !== userId) {
    live.userId = userId;
    live.ready = false;
    live.lastOrderId = 0;
    live.lastStaffTopup = 0;
    live.lastStaffOrder = 0;
    live.lastTopupId = 0;
    live.lastTopupStatus = '';
    live.balance = state.me ? Number(state.me.balance) || 0 : 0;
  }

  if (state.me && data.me) {
    const next = Number(data.me.balance) || 0;
    if (live.ready && next !== live.balance) {
      const diff = Math.round((next - live.balance) * 100) / 100;
      state.me.balance = next;
      updateBalanceChip();
      if (diff > 0) toast(`เติมเงินสำเร็จ +${money(diff)}`, 'success', 5000);
      else if (diff < 0) toast(`ตัดเครดิต ${money(Math.abs(diff))}`, 'info');
    }
    live.balance = next;
    if (live.ready && Number(data.me.lastOrderId) > live.lastOrderId) {
      toast('คำสั่งซื้อใหม่สำเร็จ — เปิดประวัติการซื้อเพื่อดูคีย์', 'success', 5000);
    }
    live.lastOrderId = Math.max(live.lastOrderId, Number(data.me.lastOrderId) || 0);

    const topup = data.me.lastTopup;
    if (topup) {
      const changed = live.ready && (topup.id !== live.lastTopupId || topup.status !== live.lastTopupStatus);
      if (changed) {
        if (topup.status === 'approved') toast(`เติมเงินอนุมัติแล้ว ${money(topup.net)} เข้าบัญชี`, 'success', 6000);
        else if (topup.status === 'rejected') toast('คำขอเติมเงินถูกปฏิเสธ — ดูเหตุผลในหน้าประวัติ', 'error', 6000);
        if (changed && currentRoute() === 'topup') renderTopup();
      }
      live.lastTopupId = topup.id;
      live.lastTopupStatus = topup.status;
    }
  }

  if (data.staff) {
    if (live.ready && Number(data.staff.pendingTopups) > live.lastStaffTopup) {
      toast(`มีคำขอเติมเงินใหม่ ${data.staff.pendingTopups} รายการ`, 'info', 6000);
    }
    if (live.ready && Number(data.staff.lastOrderId) > live.lastStaffOrder) {
      toast('มีคำสั่งซื้อใหม่เข้าระบบ', 'success', 5000);
    }
    live.lastStaffTopup = Number(data.staff.pendingTopups) || 0;
    live.lastStaffOrder = Math.max(live.lastStaffOrder, Number(data.staff.lastOrderId) || 0);
    setLiveChip(live.lastStaffTopup);
  }

  if (state.store && Array.isArray(data.products)) {
    let changed = false;
    for (const row of data.products) {
      const product = state.store.products.find((p) => p.id === row.id);
      if (!product) continue;
      if (Number(product.stock) !== Number(row.stock)) {
        product.stock = Number(row.stock);
        product.soldOut = product.stock <= 0;
        changed = true;
      }
      if (Number(product.price) !== Number(row.price)) {
        product.price = Number(row.price);
        product.yourPrice =
          state.me && state.me.role === 'dealer'
            ? Math.round(product.price * (1 - (state.config?.dealerDiscount || 0) / 100) * 100) / 100
            : product.price;
        changed = true;
      }
    }
    if (changed && currentRoute() === '') {
      paintProducts();
      paintChips();
    }
  }

  live.ready = true;
}

async function pollLive() {
  if (document.visibilityState === 'hidden') return;
  if (document.body.classList.contains('gate-open')) return;
  try {
    const data = await api('/live', { timeout: 8000 });
    const userId = state.me ? state.me.id : 0;
    if (data && (live.userId !== userId || data.rev !== live.rev)) {
      live.rev = data.rev;
      applyLive(data);
    }
  } catch {
    /* เงียบไว้แล้วลองใหม่รอบถัดไป */
  }
}

function startLive() {
  if (live.timer) return;
  pollLive();
  live.timer = setInterval(pollLive, 4000);
  if (!live.bound) {
    live.bound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pollLive();
    });
  }
}

/* ------------------------------------------------------------------ */
/* กันการ dump/copy เว็บ (ชั้นฝั่งเบราว์เซอร์)                          */
/* ------------------------------------------------------------------ */

function isProtectedKey(event) {
  const key = String(event.key || '').toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (key === 'f12') return true;
  if (mod && event.shiftKey && ['i', 'j', 'c'].includes(key)) return true;
  if (mod && ['u', 's', 'p'].includes(key)) return true;
  return false;
}

document.addEventListener('keydown', (event) => {
  if (!isProtectedKey(event)) return;
  event.preventDefault();
  toast('เนื้อหาเว็บนี้ได้รับการคุ้มครอง — ห้ามบันทึกหรือคัดลอกทั้งเว็บไซต์', 'error', 3200);
});

document.addEventListener('click', (event) => {
  const retry = event.target.closest('[data-retry]');
  if (!retry) return;
  event.preventDefault();
  window.location.reload();
});

document.addEventListener('contextmenu', (event) => {
  if (event.target.closest('img, .hero, .product-card, .gate-card, .brand-mark')) {
    event.preventDefault();
    toast('คลิกขวาถูกปิดเพื่อป้องกันการคัดลอกเนื้อหา', 'info', 2400);
  }
});

document.addEventListener('dragstart', (event) => {
  if (event.target && event.target.tagName === 'IMG') event.preventDefault();
});

async function boot() {
  app.innerHTML = `<div class="boot-screen"><div class="loader"><div class="spinner"></div></div></div>`;
  // เน็ตมือถือหลุดชั่วคราวไม่ควรทำให้ทั้งเว็บกลายเป็นหน้า error ทันที — ลองซ้ำก่อน
  let configError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      state.config = await api('/config');
      configError = null;
      break;
    } catch (err) {
      configError = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  if (configError) {
    const waitSec = Number((configError.data && configError.data.retryAfter) || 0);
    app.innerHTML = errorState(configError.message, { retry: true });
    // ถูกจำกัดความถี่/ระงับชั่วคราว → ลองเชื่อมต่อใหม่เองเมื่อพ้นเวลา
    if (configError.status === 429 && waitSec > 0) {
      setTimeout(boot, Math.min(waitSec, 30) * 1000);
    }
    return;
  }

  let verified = false;
  if (gateLocalValid()) {
    try {
      verified = Boolean((await api('/gate')).verified);
    } catch {
      verified = false;
    }
  }
  if (!verified) {
    await showGate();
    return;
  }

  await refreshMe();
  await route();
  startLive();
}

boot();
