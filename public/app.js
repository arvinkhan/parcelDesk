const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
let noticeTimer;
let user;
let tab = 'dispatch';
let rows = [];
let nextPage;
let summary;
let riders = [];
let cash = { entries: [], settlements: [] };
let demoMode = false;
let query = '';
let filter = '';

const labels = {
  ready: 'Ready to assign', assigned: 'Assigned', out_for_delivery: 'Out for delivery',
  failed: 'Attempt failed', return_requested: 'Return requested', returned: 'Returned to shop', delivered: 'Delivered',
};
const accounts = {
  dispatcher: 'dispatch@parceldesk.demo', ravi: 'ravi@parceldesk.demo', neha: 'neha@parceldesk.demo',
};
const icon = name => '<span class="icon icon-' + name + '" aria-hidden="true"></span>';
const brand = '<div class="brand"><span class="brand-icon" aria-hidden="true">' + icon('parcel') + '</span>ParcelDesk</div>';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const money = paise => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: Number(paise) % 100 ? 2 : 0,
}).format(Number(paise) / 100);
const date = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const badge = status => '<span class="badge ' + esc(status) + '">' + esc(labels[status] ?? status) + '</span>';
const initials = name => name.split(/\s+/).slice(0, 2).map(word => word[0]).join('');
const actionButton = (label, action, variant = '', symbol = '') => '<button class="button ' + variant +
  '" type="button" data-action="' + action + '">' + (symbol ? icon(symbol) : '') + label + '</button>';

async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Request failed.'), { status: response.status });
  return body;
}

function toast(message) {
  notice.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.textContent = ''; }, 4200);
}

function setRoot(html) {
  root.innerHTML = html;
  root.setAttribute('aria-busy', 'false');
}

function showLogin() {
  setRoot('<main class="login-layout"><section class="login-story">' + brand +
    '<div><h2>Local delivery<br>operations</h2><p>Dispatch orders, resolve delivery attempts, and settle cash with your riders.</p></div>' +
    '<div class="login-art" aria-hidden="true"><i></i><i></i><i></i><span>' + icon('parcel') + '</span></div></section>' +
    '<section class="login-content"><div class="auth-card"><div class="mobile-brand">' + brand + '</div><h1>Sign in</h1>' +
    '<p class="muted">Open your ParcelDesk workspace.</p>' +
    '<form class="form" id="login"><label>Email<input name="email" type="email" autocomplete="username" required></label>' +
    '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>' +
    '<p class="form-error" role="alert"></p><button class="button" type="submit">Sign in</button></form>' +
    (demoMode ? '<div class="demo-accounts"><p class="muted small">Open a demo account</p>' +
      actionButton('Dispatcher', 'demo:dispatcher', 'secondary', 'grid') + actionButton('Ravi · Rider', 'demo:ravi', 'secondary') +
      actionButton('Neha · Rider', 'demo:neha', 'secondary') + '</div>' : '') + '</div></section></main>');
  wireForm(root.querySelector('#login'), async values => signIn(Object.fromEntries(values)));
}

async function signIn(credentials) {
  await api('/login', { body: credentials });
  user = await api('/me');
  tab = 'dispatch';
  query = '';
  filter = '';
  await refresh();
}

async function refresh() {
  if (tab === 'dispatch') {
    const pageRequest = api('/shipments');
    if (user.role === 'dispatcher') {
      const data = await Promise.all([pageRequest, api('/summary'), api('/riders')]);
      rows = data[0].items;
      nextPage = data[0].next;
      summary = data[1];
      riders = data[2];
    } else {
      const page = await pageRequest;
      rows = page.items;
      nextPage = page.next;
    }
  }
  if (tab === 'riders') riders = await api('/riders');
  if (tab === 'cash') {
    [cash, riders] = await Promise.all([api('/cash'), api('/riders')]);
  }
  render();
}

const tabs = [
  ['dispatch', 'grid', 'Dispatch'], ['riders', 'person', 'Riders'], ['cash', 'wallet', 'Cash settlements'],
];
function render() {
  const dispatcher = user.role === 'dispatcher';
  const title = dispatcher ? tabs.find(item => item[0] === tab)[2] : 'My deliveries';
  const sub = {
    dispatch: dispatcher ? 'Assign shipments and handle delivery exceptions.' : 'Pick up parcels and record each delivery attempt.',
    riders: 'See current assignments and cash outstanding by rider.',
    cash: 'Record rider handovers and review any differences.',
  }[tab];
  const menu = (dispatcher ? tabs : [['dispatch', 'parcel', title]]).map(([id, symbol, label]) =>
    '<button class="nav-button" type="button" data-action="tab:' + id + '"' + (tab === id ? ' aria-current="page"' : '') +
    '>' + icon(symbol) + label + '</button>').join('');
  const hero = dispatcher && tab === 'dispatch';
  const actions = hero ? actionButton('New order', 'new', '', 'plus') +
    actionButton('Find a shipment', 'focus-queue', 'secondary', 'search') :
    dispatcher && tab === 'riders' ? actionButton('Add rider', 'new-rider', '', 'plus') : '';
  setRoot('<div class="shell"><header class="appbar"><div class="appbar-inner">' + brand +
    '<nav aria-label="Workspace">' + menu + '</nav><div class="appbar-tools">' +
    actionButton('Refresh', 'refresh', 'secondary', 'refresh') +
    '<span class="avatar" aria-hidden="true">' + esc(initials(user.name)) + '</span>' +
    '<div class="account-text"><strong>' + esc(user.name) + '</strong><span>' + (dispatcher ? 'Dispatcher' : 'Rider') +
    '</span></div><button class="signout" type="button" data-action="logout" aria-label="Sign out" title="Sign out">' +
    icon('logout') + '</button></div></div></header>' +
    '<main class="main"><div class="page-content">' +
    '<header class="heading' + (hero ? ' heading-dispatch' : '') + '"><div class="heading-content">' +
    '<span class="shop-label">' + esc(user.shop) + '</span><h1>' + title + '</h1><p class="muted">' + sub +
    '</p></div>' + (actions ? '<div class="heading-actions">' + actions + '</div>' : '') + '</header>' +
    (tab === 'dispatch' ? dispatchView(dispatcher) : tab === 'riders' ? riderView() : cashView()) + '</div></main></div>');
  const search = root.querySelector('#search');
  if (search) {
    search.addEventListener('input', () => { query = search.value; fillTable(); });
    const status = root.querySelector('#filter');
    status.addEventListener('change', () => { filter = status.value; fillTable(); });
    fillTable();
  }
}

function dispatchView(dispatcher) {
  const stats = dispatcher ? '<section class="metrics" aria-label="Shipment totals">' + [
    ['parcel', 'Total shipments', summary.total, summary.delivered + ' delivered'],
    ['route', 'Active dispatch', summary.active, 'Assigned, out, or returning'],
    ['alert', 'Failed attempts', summary.failed, 'Awaiting a dispatch decision'],
    ['wallet', 'Cash outstanding', money(summary.open_paise), 'Across all riders'],
  ].map(([symbol, label, value, caption]) => '<article class="metric"><div class="metric-head"><span class="metric-mark">' +
    icon(symbol) + '</span><h2>' + label + '</h2></div><strong>' + esc(value) + '</strong><p>' + caption + '</p></article>').join('') + '</section>' : '';
  const quick = [['all', 'All shipments'], ['ready', 'Ready to assign'], ['out_for_delivery', 'Out for delivery'],
    ['failed', 'Attempt failed'], ['delivered', 'Delivered']];
  const queue = '<section class="panel shipment-panel" aria-label="Shipment queue"><header class="panel-head"><h2>' + (dispatcher ? 'Shipments' : 'Active assignments') +
    '</h2><p class="row-count" id="row-count" role="status"></p></header>' +
    '<div class="toolbar"><div class="search-field">' + icon('search') + '<input id="search" type="search" aria-label="Search loaded shipments" placeholder="Search shipments" value="' + esc(query) + '"></div>' +
    '<select id="filter" aria-label="Shipment status"><option value="">All statuses</option>' +
    Object.entries(labels).map(([id, label]) => '<option value="' + id + '"' + (filter === id ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div>' +
    (dispatcher ? '<div class="status-filters" role="group" aria-label="Quick shipment filters">' + quick.map(([id, name]) =>
      '<button type="button" data-action="status-filter:' + id + '" data-status-filter="' + (id === 'all' ? '' : id) +
      '" aria-pressed="false">' + name + '</button>').join('') + '</div>' : '') +
    '<div id="shipment-table"></div>' + (nextPage ? '<div class="panel-foot">' + actionButton('Load more shipments', 'more', 'secondary') + '</div>' : '') +
    '</section>';
  return dispatcher ? stats + '<div class="dispatch-grid">' + queue + dispatchAside() + '</div>' : queue;
}

function dispatchAside() {
  const attention = rows.filter(row => ['failed', 'return_requested'].includes(row.status));
  const outstanding = riders.filter(rider => rider.open_entries > 0)
    .sort((left, right) => Number(right.open_paise) - Number(left.open_paise)).slice(0, 3);
  return '<aside class="dispatch-aside" aria-label="Delivery exceptions and rider cash">' +
    '<section class="panel focus-panel"><header class="panel-head"><span class="aside-mark">' + icon('alert') +
    '</span><h2>Needs attention</h2></header>' +
    (attention.length ? '<ul class="focus-list">' + attention.slice(0, 4).map(row =>
      '<li><button type="button" class="focus-row" data-action="shipment:' + row.id + '" aria-label="Review ' +
      esc(row.reference) + '"><span><strong>' + esc(row.reference) + '</strong><small>' + esc(labels[row.status]) +
      '</small></span>' + icon('chevron') + '</button></li>').join('') + '</ul>' :
      '<p class="aside-empty">No exceptions in the loaded shipments.</p>') +
    (attention.length > 4 ? '<p class="aside-empty">' + (attention.length - 4) + ' more in the shipment list</p>' : '') + '</section>' +
    '<section class="panel focus-panel"><header class="panel-head"><span class="aside-mark">' + icon('wallet') +
    '</span><h2>Cash by rider</h2></header>' +
    (outstanding.length ? '<ul class="focus-list">' + outstanding.map(rider => '<li class="cash-row"><span class="avatar" aria-hidden="true">' +
      esc(initials(rider.name)) + '</span><span><strong>' + esc(rider.name) + '</strong><small>' + rider.open_entries +
      (rider.open_entries === 1 ? ' order' : ' orders') + '</small></span><b>' + money(rider.open_paise) + '</b></li>').join('') +
      '</ul>' : '<p class="aside-empty">All rider cash is settled.</p>') +
    '<div class="aside-footer">' + actionButton('View settlements', 'tab:cash', 'text-button', 'arrow') + '</div></section></aside>';
}

function fillTable() {
  const term = query.trim().toLowerCase();
  for (const button of root.querySelectorAll('[data-status-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.statusFilter === filter));
  }
  const shown = rows.filter(row => (!filter || filter === row.status) &&
    (!term || [row.reference, row.customer, row.rider, row.description].some(value => String(value ?? '').toLowerCase().includes(term))));
  root.querySelector('#row-count').textContent = (filter || term || nextPage ? shown.length + ' of ' + rows.length : shown.length) +
    (shown.length === 1 && !(filter || term || nextPage) ? ' shipment' : ' shipments');
  const table = root.querySelector('#shipment-table');
  if (!shown.length) {
    table.innerHTML = '<div class="empty">' + icon('parcel') + '<p>' +
      (rows.length ? 'No shipments match your filters.' : 'There are no shipments here yet.') + '</p>' +
      (filter || term ? actionButton('Clear filters', 'clear-filters', 'secondary') : '') + '</div>';
    return;
  }
  const rider = user.role === 'rider';
  const cards = '<div class="card-grid shipment-cards' + (rider ? '' : ' mobile-shipments') + '">' + shown.map(row =>
    '<article class="card shipment-card"><div class="card-top"><h3>' + esc(row.reference) + '</h3>' + badge(row.status) +
    '</div><p class="shipment-customer">' + esc(row.customer) + '</p><p class="small muted">' + esc(rider ? row.address : row.description) +
    '</p><div class="shipment-card-foot"><span><strong>' + (row.payment === 'cod' ? money(row.cod_paise) + ' COD' : 'Prepaid') +
    '</strong>' + (!rider && row.rider ? '<small>' + esc(row.rider) + '</small>' : '') +
    '</span><button type="button" class="button secondary" data-action="shipment:' + row.id +
    '" aria-label="Open ' + esc(row.reference) + '">Open ' + (rider ? 'delivery' : 'order') + icon('chevron') + '</button></div></article>').join('') + '</div>';
  table.innerHTML = (rider ? '' : '<div class="table-scroll desktop-shipments"><table><thead><tr>' +
    '<th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Rider</th><th scope="col">Payment</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
    shown.map(row => '<tr><td><button type="button" class="table-link" data-action="shipment:' + row.id + '">' + esc(row.reference) +
      '</button><small class="parcel-description" title="' + esc(row.description) + '">' + esc(row.description) + '</small></td><td>' +
      '<span class="customer-name">' + esc(row.customer) + '</span></td><td>' + badge(row.status) +
      '</td><td>' + (row.rider ? '<span class="rider-name"><span class="avatar mini" aria-hidden="true">' +
        esc(initials(row.rider)) + '</span>' + esc(row.rider) + '</span>' :
        '<span class="muted">' + (row.status === 'delivered' ? '—' : 'Unassigned') + '</span>') +
      '</td><td>' + (row.payment === 'cod' ? '<strong>' + money(row.cod_paise) + '</strong><small>COD</small>' : '<span class="muted">Prepaid</span>') +
      '</td><td><button class="button icon-button secondary" type="button" data-action="shipment:' + row.id + '" aria-label="Open ' +
      esc(row.reference) + '">' + icon('chevron') + '</button></td></tr>').join('') + '</tbody></table></div>') + cards;
}

function riderView() {
  if (!riders.length) return '<section class="panel"><p class="empty">There are no riders in this workspace yet.</p></section>';
  return '<section class="card-grid" aria-label="Riders">' + riders.map(rider =>
    '<article class="card"><div class="card-top"><span class="avatar" aria-hidden="true">' + esc(initials(rider.name)) +
    '</span><h2>' + esc(rider.name) + '</h2></div><div class="stats"><div><strong>' + rider.active +
    '</strong><p class="muted small">Active assignments</p></div><div><strong>' + money(rider.open_paise) +
    '</strong><p class="muted small">Cash outstanding</p></div></div>' +
    (rider.open_entries > 0 ? actionButton('Record handover', 'settle:' + rider.id, 'secondary') : '') + '</article>').join('') + '</section>';
}

function cashView() {
  const openTotal = cash.entries.reduce((sum, entry) => sum + entry.amount_paise, 0);
  const openCards = cash.entries.map(entry =>
    '<article class="card"><div class="card-top"><span class="avatar" aria-hidden="true">' + esc(initials(entry.rider)) +
    '</span><div><h3>' + esc(entry.rider) + '</h3><p class="muted small">' + esc(entry.reference) +
    '</p></div></div><div class="shipment-card-foot"><strong>' + money(entry.amount_paise) + '</strong>' +
    actionButton('Record handover', 'settle:' + entry.rider_id, 'secondary') + '</div></article>').join('');
  const historyCards = cash.settlements.map(item =>
    '<article class="card"><div class="card-top"><span class="avatar" aria-hidden="true">' + esc(initials(item.rider)) +
    '</span><div><h3>' + esc(item.rider) + '</h3><p class="muted small">' + esc(item.references?.join(', ')) +
    '</p></div></div><div class="stats"><div><strong>' + money(item.expected_paise) + '</strong><p class="muted small">Expected</p></div>' +
    '<div><strong>' + money(item.received_paise) + '</strong><p class="muted small">Received</p></div></div>' +
    '<div class="shipment-card-foot">' + settlementVariance(item) + '</div></article>').join('');
  return '<section class="cash-overview"><span class="metric-mark">' + icon('wallet') + '</span><div>' +
    '<h2>Outstanding rider cash</h2><p class="small muted">' + cash.entries.length + (cash.entries.length === 1 ? ' order awaiting handover' : ' orders awaiting handover') +
    '</p></div><strong>' + money(openTotal) + '</strong></section>' +
    '<section class="panel"><div class="panel-head"><h2>Cash awaiting handover</h2></div>' +
    (cash.entries.length ? '<div class="table-scroll desktop-cash"><table><thead><tr><th>Rider</th><th>Order</th><th>Expected</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
      cash.entries.map(entry => '<tr><td>' + esc(entry.rider) + '</td><td>' + esc(entry.reference) + '</td><td>' + money(entry.amount_paise) +
        '</td><td>' + actionButton('Record handover', 'settle:' + entry.rider_id, 'secondary') + '</td></tr>').join('') +
      '</tbody></table></div><div class="card-grid shipment-cards mobile-cash">' + openCards +
      '</div>' : '<p class="empty">All cash entries have been settled.</p>') + '</section>' +
    '<section class="panel"><div class="panel-head"><h2>Settlement history</h2></div>' +
    (cash.settlements.length ? '<div class="table-scroll desktop-cash"><table><thead><tr><th>Rider</th><th>Orders</th><th>Expected</th><th>Received</th><th>Difference</th><th>Recorded</th></tr></thead><tbody>' +
      cash.settlements.map(item =>
        '<tr><td>' + esc(item.rider) + '</td><td>' + esc(item.references?.join(', ')) + '</td><td>' + money(item.expected_paise) +
        '</td><td>' + money(item.received_paise) + '</td><td>' + settlementVariance(item) +
        '</td><td>' + date(item.created_at) + '</td></tr>').join('') +
      '</tbody></table></div><div class="card-grid shipment-cards mobile-cash">' + historyCards +
      '</div>' : '<p class="empty">No settlements recorded yet.</p>') + '</section>';
}

function settlementVariance(item) {
  const diff = item.received_paise - item.expected_paise;
  return '<span class="variance"><strong' + (diff ? ' class="shortfall"' : '') + '>' +
    (diff ? money(Math.abs(diff)) + (diff < 0 ? ' short' : ' over') : 'Balanced') + '</strong>' +
    (item.note ? '<small>' + esc(item.note) + '</small>' : '') + '</span>';
}

function modal(title, subtitle, content) {
  dialog.innerHTML = '<header class="modal-head"><div><h2 id="dialog-title" tabindex="-1">' + esc(title) + '</h2>' +
    (subtitle ? '<p class="muted small">' + esc(subtitle) + '</p>' : '') +
    '</div><button class="close" type="button" aria-label="Close dialog" data-action="close">×</button></header>' +
    '<div class="modal-body">' + content + '</div>';
  if (dialog.open) dialog.querySelector('#dialog-title').focus();
  else dialog.showModal();
}

function wireForm(form, handler) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const error = form.querySelector('.form-error');
    button.disabled = true;
    error.textContent = '';
    try { await handler(new FormData(form)); } catch (failure) {
      error.textContent = failure.message;
    } finally { button.disabled = false; }
  });
}

function amountPaise(value) {
  const matching = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!matching) throw new Error('Enter a rupee amount with up to two decimal places.');
  return Number(matching[1]) * 100 + Number((matching[2] ?? '').padEnd(2, '0'));
}

function newOrder() {
  modal('New order', 'Create a shipment for local delivery.', '<form id="new" class="form">' +
    '<div class="form-row"><label>Order reference<input name="reference" required maxlength="32" placeholder="PD-1048"></label>' +
    '<label>Customer name<input name="customer" required maxlength="100"></label></div>' +
    '<label>Parcel description<input name="description" required maxlength="200"></label>' +
    '<label>Delivery address<textarea name="address" required maxlength="300"></textarea></label>' +
    '<div class="form-row"><label>Payment<select name="payment"><option value="prepaid">Prepaid</option><option value="cod">Cash on delivery</option></select></label>' +
    '<label>COD amount (₹)<input name="amount" inputmode="decimal" type="number" min="0.01" step="0.01" disabled></label></div>' +
    '<p class="form-error" role="alert"></p><div class="actions"><button class="button" type="submit">Create order</button></div></form>');
  const form = dialog.querySelector('#new');
  form.elements.payment.addEventListener('change', () => {
    const cod = form.elements.payment.value === 'cod';
    form.elements.amount.disabled = !cod;
    form.elements.amount.required = cod;
  });
  wireForm(form, async data => {
    const { amount, ...body } = Object.fromEntries(data);
    body.cod_paise = body.payment === 'cod' ? amountPaise(amount) : 0;
    const { id } = await api('/shipments', { body });
    await refresh();
    await showShipment(id);
    toast('Order created.');
  });
}

function newRider() {
  modal('Add rider', 'Create a rider account for this shop.', '<form id="new-rider" class="form">' +
    '<label>Full name<input name="name" maxlength="100" required></label>' +
    '<label>Email<input name="email" type="email" maxlength="254" required></label>' +
    '<label>Password<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>' +
    '<p class="form-error" role="alert"></p><button class="button" type="submit">Create rider account</button></form>');
  wireForm(dialog.querySelector('#new-rider'), async values => {
    await api('/riders', { body: Object.fromEntries(values) });
    dialog.close();
    await refresh();
    toast('Rider account created.');
  });
}

async function showShipment(id) {
  const shipment = await api('/shipments/' + id);
  const isDispatcher = user.role === 'dispatcher';
  let actions = '';
  if (isDispatcher && ['ready', 'returned'].includes(shipment.status)) {
    actions = '<form class="form" id="assign"><div class="actions"><label>Rider<select name="rider" aria-label="Rider" required><option value="">Select a rider</option>' +
      riders.map(rider => '<option value="' + rider.id + '">' + esc(rider.name) + '</option>').join('') +
      '</select></label><button class="button" type="submit">Assign rider</button></div><p class="form-error" role="alert"></p></form>';
  } else {
    const buttons = [];
    if (!isDispatcher && shipment.status === 'assigned') buttons.push(actionButton('Confirm pickup', 'pickup:' + id + ':' + shipment.assignment_id));
    if (!isDispatcher && shipment.status === 'out_for_delivery') {
      buttons.push(actionButton('Mark delivered', 'complete:' + id + ':' + shipment.assignment_id));
      buttons.push(actionButton('Record failed attempt', 'fail:' + id + ':' + shipment.assignment_id, 'warning'));
    }
    if (isDispatcher && shipment.status === 'failed') buttons.push(actionButton('Approve retry', 'send:retry:' + id));
    if (isDispatcher && shipment.status === 'assigned') buttons.push(actionButton('Remove assignment', 'send:unassign:' + id, 'warning'));
    if (isDispatcher && ['failed', 'out_for_delivery'].includes(shipment.status)) buttons.push(actionButton('Request return', 'send:request_return:' + id, 'warning'));
    if (isDispatcher && shipment.status === 'return_requested') buttons.push(actionButton('Confirm return to shop', 'send:confirm_return:' + id));
    if (buttons.length) actions = '<div class="actions">' + buttons.join('') + '</div>';
  }
  modal(shipment.reference, shipment.description, '<section><dl class="details"><div><dt>Status</dt><dd>' + badge(shipment.status) +
    '</dd></div><div><dt>Customer</dt><dd>' + esc(shipment.customer) + '</dd></div><div><dt>Address</dt><dd>' + esc(shipment.address) +
    '</dd></div><div><dt>Assigned rider</dt><dd>' + esc(shipment.rider ?? '—') + '</dd></div><div><dt>Payment</dt><dd>' +
    (shipment.payment === 'cod' ? money(shipment.cod_paise) + ' COD' : 'Prepaid') + '</dd></div></dl>' + actions +
    (isDispatcher ? '<div class="actions"><a class="button secondary" href="/track/' + shipment.tracking_token +
      '" target="_blank" rel="noopener">Open tracking link ↗</a></div>' : '') + '</section>' +
    '<section><h3>Activity</h3><ol class="timeline">' + shipment.events.map(event => '<li>' + esc(event.detail) +
      '<time>' + date(event.created_at) + '</time></li>').join('') + '</ol></section>' +
    (shipment.attempts.length ? '<section><h3>Delivery attempts</h3><ol class="timeline">' + shipment.attempts.map(item =>
      '<li>' + esc(item.rider) + ' · ' + (item.reason ? esc(item.reason) : 'Delivered') +
      '<time>' + date(item.created_at) + '</time></li>').join('') + '</ol></section>' : ''));
  const assign = dialog.querySelector('#assign');
  if (assign) wireForm(assign, values => send(id, { kind: 'assign', rider_id: values.get('rider') }));
}

async function send(id, body) {
  await api('/shipments/' + id + '/actions', { body });
  await refresh();
  if (user.role === 'rider' && body.outcome === 'delivered') dialog.close();
  else await showShipment(id);
  toast('Shipment updated.');
}

function recordAttempt(id, assignmentId, outcome) {
  const submissionId = crypto.randomUUID();
  const failed = outcome === 'failed';
  modal(failed ? 'Record failed attempt' : 'Confirm delivery', '',
    '<form class="form" id="attempt">' + (failed ? '<label>Reason<textarea name="reason" required maxlength="500" placeholder="Customer unavailable"></textarea></label>' :
      '<p class="muted small">Confirm the parcel was handed to the customer and any COD cash was collected.</p>') +
    '<p class="form-error" role="alert"></p><div class="actions"><button class="button" type="submit">' +
    (failed ? 'Save attempt' : 'Confirm delivery') + '</button>' + actionButton('Back', 'shipment:' + id, 'secondary') + '</div></form>');
  wireForm(dialog.querySelector('#attempt'), data => send(id, {
    kind: 'attempt', assignment_id: assignmentId, submission_id: submissionId, outcome, ...(failed ? { reason: data.get('reason') } : {}),
  }));
}

async function openSettlement(id) {
  if (tab !== 'cash') {
    [cash, riders] = await Promise.all([api('/cash'), api('/riders')]);
  }
  const rider = riders.find(item => item.id === id);
  const entries = cash.entries.filter(item => item.rider_id === id);
  if (!rider || !entries.length) throw new Error('This rider has no open cash entries.');
  const submissionId = crypto.randomUUID();
  modal('Record cash handover', rider.name, '<form class="form" id="settlement">' +
    entries.map(entry => '<label class="cash-check"><input type="checkbox" name="entry" value="' + entry.id + '" checked><span>' +
      esc(entry.reference) + '</span>' + money(entry.amount_paise) + '</label>').join('') +
    '<p class="small">Expected for selected orders <strong id="expected"></strong></p>' +
    '<label>Cash received (₹)<input type="number" name="received" inputmode="decimal" min="0" step="0.01" required></label>' +
    '<label>Settlement note<textarea name="note" maxlength="500" placeholder="Required if the amounts differ"></textarea></label>' +
    '<p class="form-error" role="alert"></p><div class="actions"><button class="button" type="submit">Save settlement</button></div></form>');
  const form = dialog.querySelector('#settlement');
  function expected() {
    const selected = new Set(new FormData(form).getAll('entry'));
    return entries.reduce((sum, entry) => sum + (selected.has(entry.id) ? entry.amount_paise : 0), 0);
  }
  const updateTotal = () => { dialog.querySelector('#expected').textContent = money(expected()); };
  form.elements.received.value = (expected() / 100).toFixed(2);
  updateTotal();
  form.addEventListener('change', updateTotal);
  wireForm(form, async data => {
    const entry_ids = data.getAll('entry');
    if (!entry_ids.length) throw new Error('Select at least one cash entry.');
    const note = String(data.get('note')).trim();
    await api('/settlements', { body: {
      rider_id: id, submission_id: submissionId, entry_ids, received_paise: amountPaise(data.get('received')), ...(note ? { note } : {}),
    } });
    dialog.close();
    await refresh();
    toast('Cash settlement recorded.');
  });
}

async function publicTracking(token) {
  try {
    const item = await api('/track/' + token);
    setRoot('<main class="center"><section class="auth-card tracking-card">' + brand + '<h1>Track your order</h1><p class="muted">' +
      esc(item.shop) + ' · ' + esc(item.reference) + '</p><div class="tracking-status"><span class="metric-mark">' +
      icon('route') + '</span><div>' + badge(item.status) + '<p class="muted small">Updated ' + date(item.updated_at) + '</p></div></div>' +
      actionButton('Refresh status', 'track:' + token, 'secondary', 'refresh') + '</section></main>');
  } catch (error) {
    setRoot('<main class="center"><section class="auth-card">' + brand + '<h1>Order tracking</h1><p class="muted">' +
      esc(error.message) + '</p></section></main>');
  }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const [kind, value, id] = target.dataset.action.split(':');
  target.disabled = true;
  try {
    if (kind === 'close') dialog.close();
    if (kind === 'new') newOrder();
    if (kind === 'new-rider') newRider();
    if (kind === 'shipment') await showShipment(value);
    if (kind === 'settle') await openSettlement(value);
    if (kind === 'complete' || kind === 'fail') recordAttempt(value, id, kind === 'complete' ? 'delivered' : 'failed');
    if (kind === 'pickup') await send(value, { kind: 'pickup', assignment_id: id });
    if (kind === 'send') await send(id, { kind: value });
    if (kind === 'demo') await signIn({ email: accounts[value], password: 'ParcelDeskDemo!' });
    if (kind === 'track') await publicTracking(value);
    if (kind === 'refresh') await refresh();
    if (kind === 'focus-queue') root.querySelector('#search').focus();
    if (kind === 'status-filter') {
      filter = value === 'all' ? '' : value;
      root.querySelector('#filter').value = filter;
      fillTable();
    }
    if (kind === 'clear-filters') {
      query = '';
      filter = '';
      root.querySelector('#search').value = '';
      root.querySelector('#filter').value = '';
      fillTable();
      root.querySelector('#search').focus();
    }
    if (kind === 'more') {
      const page = await api('/shipments?before=' + encodeURIComponent(nextPage));
      rows.push(...page.items.filter(item => !rows.some(row => row.id === item.id)));
      nextPage = page.next;
      render();
    }
    if (kind === 'tab') { tab = value; await refresh(); }
    if (kind === 'logout') {
      await api('/logout', { method: 'POST' });
      user = undefined;
      showLogin();
    }
  } catch (error) {
    if (error.status === 401 && user) {
      user = undefined;
      if (dialog.open) dialog.close();
      showLogin();
    }
    if (dialog.open) {
      const message = document.createElement('p');
      message.className = 'form-error';
      message.setAttribute('role', 'alert');
      message.textContent = error.message;
      dialog.querySelector('.action-error')?.remove();
      message.classList.add('action-error');
      dialog.querySelector('.modal-body').prepend(message);
    } else {
      toast(error.message);
    }
  } finally {
    target.disabled = false;
  }
});

try {
  const token = /^\/track\/([a-f\d-]+)$/i.exec(location.pathname)?.[1];
  if (token) {
    await publicTracking(token);
  } else {
    const config = await api('/config');
    demoMode = config.demo_mode;
    try {
      user = await api('/me');
      await refresh();
    } catch (error) {
      if (error.status !== 401) throw error;
      showLogin();
    }
  }
} catch (error) {
  setRoot('<main class="center"><section class="auth-card">' + brand +
    '<h1>Could not open ParcelDesk</h1><p class="muted">' + esc(error.message) + '</p></section></main>');
}
