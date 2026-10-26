// Role-aware testing console. Every business action is a real gateway call with the signed-in user's JWT;
// the backend enforces roles and ownership. /devtools/api/* is used only for observability (health, queues,
// events, Mailpit). Tokens live only in memory (reloading the page signs you out) and are never logged.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rupees = (p) => (typeof p === 'number' ? `₹${(p / 100).toFixed(2)}` : '—');
const toPaise = (v) => Math.round(Number(v) * 100);
const time = (t) => (t ? new Date(t).toLocaleTimeString() : '—');
const dateTime = (t) => (t ? new Date(t).toLocaleString() : '—');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;
const statusKind = (s) => (['ok', 'up', 'delivered', 'paid', 'succeeded', 'available', 'active'].includes(s) ? 'ok' : ['degraded', 'pending', 'pending_payment', 'busy', 'refund_pending'].includes(s) ? 'warn' : ['unhealthy', 'unreachable', 'down', 'cancelled', 'expired', 'failed', 'error', 'offline', 'inactive'].includes(s) ? 'bad' : '');
const ROLE_LABEL = { customer: 'Customer', restaurant_admin: 'Restaurant administrator', delivery_agent: 'Delivery agent', platform_admin: 'Platform administrator' };

const state = { gateway: 'http://localhost:8080', mailpitUrl: 'http://localhost:8025', session: null, menu: null, order: null, payment: null, tracking: null, sse: null, owned: [], ownerMenu: null };
const token = () => state.session?.token;
const role = () => state.session?.user.role;

// ------------------------------------------------------------------ gateway client + request log
async function api(method, path, { body, anonymous = false } = {}) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${state.gateway}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token() && !anonymous ? { authorization: `Bearer ${token()}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    logLine(method, path, 'network error', '', 0);
    throw new Error(`Gateway unreachable (${err.message})`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  logLine(method, path, res.status, res.headers.get('x-request-id') ?? '', Math.round(performance.now() - started));
  return { status: res.status, body: json, headers: res.headers };
}
function logLine(method, path, status, requestId, ms) {
  const div = document.createElement('div');
  const kind = typeof status === 'number' && status < 300 ? 'okc' : status === 404 || status === 409 || status === 503 ? '' : 'err';
  div.innerHTML = `${time(Date.now())} <b>${esc(method)}</b> ${esc(path)} → <span class="${kind}">${esc(status)}</span> ${ms ? `${ms} ms` : ''} <span class="muted">${esc(requestId)}</span>`;
  $('log').prepend(div);
}
const dev = async (path) => (await fetch(`/devtools/api${path}`)).json();
const errText = (r) => {
  const e = r.body?.error ?? {};
  const details = Array.isArray(e.details) ? ` (${e.details.map((d) => `${d.path ?? ''} ${d.message}`.trim()).join('; ')})` : '';
  return `${r.status} ${e.code ?? ''} ${e.message ?? ''}${details}`.trim();
};
const show = (id, html, isError = false) => ($(id).innerHTML = isError ? `<p class="err">${esc(html)}</p>` : html);
const ok = (id, text) => show(id, `<p class="okc">${esc(text)}</p>`);
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function busy(btn, fn, msgId) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    if (msgId) show(msgId, err.message, true);
    else alert(err.message);
  } finally {
    btn.disabled = false;
  }
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const onSubmit = (id, fn, msgId) =>
  $(id).addEventListener('submit', (e) => {
    e.preventDefault();
    void busy($(id).querySelector('button[type=submit]'), () => fn($(id), formData($(id))), msgId);
  });
const onClick = (id, fn, msgId) => $(id).addEventListener('click', () => busy($(id), fn, msgId));
const checkPassword = (d) => {
  need(d.password === d.confirm, 'The passwords do not match');
  need(/[A-Za-z]/.test(d.password) && /\d/.test(d.password) && d.password.length >= 8, 'Password needs 8+ characters with a letter and a digit');
};

// ------------------------------------------------------------------ session + role-aware layout
function applyRole() {
  const r = role();
  for (const el of document.querySelectorAll('[data-roles]')) {
    const roles = el.dataset.roles.split(' ');
    el.hidden = !(roles.includes(r ?? 'guest') || (r && roles.includes('signed-in')));
  }
  updateCreateUser();
  if (state.session) {
    const u = state.session.user;
    $('whoami').innerHTML = `Signed in as <b>${esc(u.name)}</b> · ${esc(u.email)} · ${pill(ROLE_LABEL[u.role] ?? u.role, 'ok')}`;
  }
}

async function login(form, d) {
  const r = await api('POST', '/auth/login', { body: { email: d.email.trim(), password: d.password } });
  need(r.status === 200, errText(r));
  form.reset();
  state.session = { token: r.body.data.accessToken, user: r.body.data.user };
  show('accountMsg', '');
  applyRole();
  await onSignedIn();
}

function logout() {
  state.sse?.abort();
  Object.assign(state, { session: null, menu: null, order: null, payment: null, tracking: null, sse: null, owned: [], ownerMenu: null });
  for (const id of ['orderInfo', 'invoice', 'payment', 'customerOtp', 'cancel', 'tracking', 'events', 'mail', 'myOrders', 'users', 'assignMsg', 'asgList', 'myRestaurantInfo', 'ownerMenu', 'menuMsg', 'restaurantOrders', 'createRestaurantMsg', 'agentProfile', 'agentMsg', 'menu']) $(id).innerHTML = '';
  $('agentDelivery').innerHTML = '<p class="muted">No active delivery.</p>';
  state.pendingAssign = null;
  $('btnRetryAssign').hidden = true;
  $('sseState').textContent = 'no order selected';
  $('sseState').className = 'pill';
  applyRole();
  ok('accountMsg', 'Signed out.');
}

async function onSignedIn() {
  const r = role();
  if (r === 'customer') {
    const u = state.session.user;
    const a = u.addresses?.[0];
    if (a) {
      $('addrLine1').value = a.line1;
      $('addrCity').value = a.city;
      $('addrPincode').value = a.pincode;
    }
    await Promise.all([loadRestaurants(), loadMyOrders(), refreshMail()]);
  } else if (r === 'platform_admin') {
    await Promise.all([loadUsers(), loadAssignments()]);
  } else if (r === 'restaurant_admin') {
    await loadMyRestaurants();
  } else if (r === 'delivery_agent') {
    $('agentPhone').value = state.session.user.phone ?? '';
    await refreshAgent();
  }
}

// ------------------------------------------------------------------ shared helpers
/** All restaurants visible to the caller (pages through the 50-per-page limit). */
async function allRestaurants(extra = '') {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api('GET', `/restaurants?limit=50&page=${page}&sort=name${extra}`);
    need(r.status === 200, errText(r));
    out.push(...r.body.data);
    if (page >= r.body.meta.totalPages) break;
  }
  return out;
}

// ------------------------------------------------------------------ platform admin
/** Privileged roles need a signed-in platform admin; the backend enforces this regardless of the UI. */
function updateCreateUser() {
  const form = $('createUserForm');
  const blocked = form.role.value !== 'customer' && role() !== 'platform_admin';
  $('createUserWarning').hidden = !blocked;
  $('btnCreateUser').disabled = blocked;
  $('cuRestaurantsWrap').hidden = !(role() === 'platform_admin' && form.role.value === 'restaurant_admin');
}

const selectedValues = (sel) => [...sel.selectedOptions].map((o) => o.value).filter(Boolean);
const restaurantName = (id) => state.restaurants?.find((x) => x.id === id)?.name ?? id;

async function createUser(form, d) {
  checkPassword(d);
  const body = { name: d.name.trim(), email: d.email.trim(), password: d.password };
  const restaurants = d.role === 'restaurant_admin' ? selectedValues($('cuRestaurants')) : [];
  if (role() === 'platform_admin' && d.role === 'restaurant_admin') need(restaurants.length, 'Select at least one restaurant for the new restaurant administrator');
  let r;
  if (role() === 'platform_admin') {
    r = await api('POST', '/auth/users', { body: { ...body, role: d.role } }); // admin JWT, any role
  } else {
    need(d.role === 'customer', 'You must be logged in as a Platform Administrator to create this account type.');
    r = await api('POST', '/auth/register', { body, anonymous: true }); // public: always a customer
  }
  need(r.status === 201, errText(r));
  form.password.value = '';
  form.confirm.value = '';
  const user = r.body.data;
  if (user.role === 'restaurant_admin' && restaurants.length) {
    state.pendingAssign = { userId: user.id, email: user.email, restaurantIds: restaurants };
    await assignPending();
  } else {
    ok('createUserMsg', `Created ${user.email} with role ${user.role}.`);
  }
  if (role() === 'platform_admin') await Promise.all([loadUsers(), loadAssignments()]);
  else if (!state.session) $('loginForm').email.value = user.email;
}

/**
 * Assigns the just-created administrator to the selected restaurants (POST /restaurants/:id/admins, idempotent).
 * Failures are reported as a partial result; Retry repeats only the failed assignments — never the account creation.
 */
async function assignPending() {
  const p = state.pendingAssign;
  if (!p) return;
  const failed = [];
  for (const id of p.restaurantIds) {
    const a = await api('POST', `/restaurants/${id}/admins`, { body: { userId: p.userId } });
    if (a.status !== 200) failed.push({ id, error: errText(a) });
  }
  const done = p.restaurantIds.filter((id) => !failed.some((f) => f.id === id));
  if (!failed.length) {
    state.pendingAssign = null;
    $('btnRetryAssign').hidden = true;
    ok('createUserMsg', `Created ${p.email} (restaurant_admin) and assigned to: ${p.restaurantIds.map(restaurantName).join(', ')}.`);
    return;
  }
  state.pendingAssign = { ...p, restaurantIds: failed.map((f) => f.id) };
  $('btnRetryAssign').hidden = false;
  show(
    'createUserMsg',
    `<p class="err">Partial result: the account ${esc(p.email)} WAS created, but assignment to ${failed.length} restaurant(s) failed.</p>
     ${done.length ? `<p class="okc">Assigned: ${esc(done.map(restaurantName).join(', '))}</p>` : ''}
     <ul>${failed.map((f) => `<li>${esc(restaurantName(f.id))}: ${esc(f.error)}</li>`).join('')}</ul>
     <p class="muted">Use <b>Retry restaurant assignment</b> (re-sends only the failed assignments; the account is not created again) or assign later under <i>Restaurant administrators</i>.</p>`,
  );
}

async function loadUsers() {
  const filter = $('userRoleFilter').value;
  const r = await api('GET', `/auth/users?limit=100${filter ? `&role=${filter}` : ''}`);
  need(r.status === 200, errText(r));
  state.users = r.body.data;
  $('users').innerHTML = `<p class="muted">${esc(r.body.meta.total)} user(s)${r.body.meta.total > 100 ? ' (showing 100)' : ''}</p><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Phone</th><th>Active</th></tr>${r.body.data
    .map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.phone ?? '')}</td><td>${u.isActive ? 'yes' : pill('no', 'bad')}</td></tr>`)
    .join('')}</table>`;
}

async function loadAssignments() {
  const [restaurants, admins] = await Promise.all([allRestaurants('&includeInactive=true'), api('GET', '/auth/users?limit=100&role=restaurant_admin')]);
  need(admins.status === 200, errText(admins));
  state.restaurants = restaurants;
  state.restaurantAdmins = admins.body.data;
  const keep = $('asgRestaurant').value;
  const options = restaurants.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.address?.city)} · ${esc((x.adminIds ?? []).length)} admin(s)${x.status === 'inactive' ? ' · inactive' : ''}</option>`).join('');
  $('asgRestaurant').innerHTML = options || '<option value="">No restaurants yet — create one below</option>';
  if (keep && restaurants.some((x) => x.id === keep)) $('asgRestaurant').value = keep;
  const keepSel = new Set(selectedValues($('cuRestaurants')));
  $('cuRestaurants').innerHTML = restaurants.map((x) => `<option value="${esc(x.id)}"${keepSel.has(x.id) ? ' selected' : ''}>${esc(x.name)} · ${esc(x.address?.city)}</option>`).join('');
  const adminOptions = admins.body.data.filter((u) => u.isActive).map((u) => `<option value="${esc(u.id)}">${esc(u.name)} (${esc(u.email)})</option>`).join('');
  $('crAdmins').innerHTML = adminOptions;
  renderAssignments();
}

function renderAssignments() {
  const x = state.restaurants?.find((r) => r.id === $('asgRestaurant').value);
  if (!x) {
    $('asgList').innerHTML = '';
    $('asgAdmin').innerHTML = '';
    return;
  }
  const byId = Object.fromEntries((state.restaurantAdmins ?? []).map((u) => [u.id, u]));
  const ids = x.adminIds ?? [];
  $('asgList').innerHTML = ids.length
    ? `<table class="small"><tr><th>Administrator</th><th>User id</th><th></th></tr>${ids
        .map((id) => {
          const u = byId[id];
          const who = u ? `${esc(u.name)} (${esc(u.email)})${u.isActive ? '' : ` ${pill('inactive', 'bad')}`}` : '<span class="muted">not a current restaurant_admin account</span>';
          return `<tr><td>${who}</td><td class="mono">${esc(id)}</td><td><button class="tiny warn" data-remove="${esc(id)}">Remove</button></td></tr>`;
        })
        .join('')}</table>`
    : '<p class="muted">No administrators assigned to this restaurant.</p>';
  const available = (state.restaurantAdmins ?? []).filter((u) => u.isActive && !ids.includes(u.id));
  $('asgAdmin').innerHTML = available.length
    ? available.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} (${esc(u.email)})</option>`).join('')
    : '<option value="">No other active restaurant administrators</option>';
}

async function addRestaurantAdmin() {
  const id = $('asgRestaurant').value;
  const userId = $('asgAdmin').value;
  need(id, 'Choose a restaurant');
  need(userId, 'Choose a restaurant administrator');
  const r = await api('POST', `/restaurants/${id}/admins`, { body: { userId } });
  need(r.status === 200, errText(r));
  ok('assignMsg', `Administrator added to ${r.body.data.name}.`);
  await loadAssignments();
}

async function removeRestaurantAdmin(userId) {
  const id = $('asgRestaurant').value;
  if (!confirm('Remove this administrator from the restaurant?')) return;
  const r = await api('DELETE', `/restaurants/${id}/admins/${userId}`);
  need(r.status === 200, errText(r));
  ok('assignMsg', `Administrator removed from ${r.body.data.name}.`);
  await loadAssignments();
}

// ------------------------------------------------------------------ restaurant admin
async function loadMyRestaurants(selectId) {
  const r = await api('GET', '/restaurants/mine');
  need(r.status === 200, errText(r));
  state.owned = r.body.data;
  $('myRestaurant').innerHTML = state.owned.length
    ? state.owned.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.address?.city)}${x.status === 'inactive' ? ' · inactive' : ''}</option>`).join('')
    : '<option value="">No restaurants are assigned to you yet</option>';
  if (selectId) $('myRestaurant').value = selectId;
  await showMyRestaurant();
}
const current = () => state.owned.find((x) => x.id === $('myRestaurant').value);

async function showMyRestaurant() {
  const x = current();
  if (!x) {
    show('myRestaurantInfo', '<p class="muted">A platform administrator assigns restaurants to you. Refresh once you have been assigned.</p>');
    $('ownerMenu').innerHTML = '';
    $('restaurantOrders').innerHTML = '';
    return;
  }
  show('myRestaurantInfo', `<dl class="kv"><dt>Status</dt><dd>${pill(x.isOpen ? 'open' : 'closed', x.isOpen ? 'ok' : 'bad')} ${pill(x.status, statusKind(x.status))}</dd><dt>Cuisines</dt><dd>${esc(x.cuisines.join(', '))}</dd><dt>Address</dt><dd>${esc(`${x.address.line1}, ${x.address.area}, ${x.address.city} ${x.address.pincode}`)}</dd><dt>Hours</dt><dd>${esc(x.openingHours?.opens)}–${esc(x.openingHours?.closes)}</dd><dt>Cost for two</dt><dd>${rupees(x.costForTwo)} · ~${esc(x.avgDeliveryMinutes)} min</dd><dt>Administrators</dt><dd class="mono">${esc((x.adminIds ?? []).join(', '))}</dd></dl>`);
  const f = $('editRestaurantForm');
  f.description.value = x.description;
  f.costForTwo.value = x.costForTwo / 100;
  f.avgDeliveryMinutes.value = x.avgDeliveryMinutes;
  await Promise.all([loadOwnerMenu(), loadRestaurantOrders()]);
}

async function toggleOpen() {
  const x = current();
  need(x, 'Select a restaurant');
  const r = await api('PATCH', `/restaurants/${x.id}/open`, { body: { isOpen: !x.isOpen } });
  need(r.status === 200, errText(r));
  await loadMyRestaurants(x.id);
}

async function saveRestaurant(_form, d) {
  const x = current();
  need(x, 'Select a restaurant');
  const r = await api('PATCH', `/restaurants/${x.id}`, { body: { description: d.description.trim(), costForTwo: toPaise(d.costForTwo), avgDeliveryMinutes: Number(d.avgDeliveryMinutes) } });
  need(r.status === 200, errText(r));
  await loadMyRestaurants(x.id);
  ok('menuMsg', 'Restaurant details saved.');
}

async function loadOwnerMenu() {
  const x = current();
  if (!x) return;
  const r = await api('GET', `/restaurants/${x.id}/menu`);
  need(r.status === 200, errText(r));
  state.ownerMenu = r.body.data;
  $('ownerMenu').innerHTML = r.body.data.items.length
    ? `<table class="small"><tr><th>Name / description</th><th>Category</th><th>Price ₹</th><th>Available</th><th></th></tr>${r.body.data.items
        .map(
          (i) => `<tr data-item="${esc(i.id)}">
            <td><input data-f="name" value="${esc(i.name)}"><br><input data-f="description" value="${esc(i.description)}" placeholder="description"></td>
            <td>${esc(i.category)} ${pill(i.isVeg ? 'veg' : 'non-veg', i.isVeg ? 'ok' : 'bad')}</td>
            <td><input data-f="price" type="number" min="1" step="0.01" value="${(i.price / 100).toFixed(2)}" style="width:90px"></td>
            <td><button class="tiny ${i.isAvailable ? 'ok' : 'secondary'}" data-act="avail" data-v="${i.isAvailable ? 'false' : 'true'}">${i.isAvailable ? 'available' : 'unavailable'}</button></td>
            <td><button class="tiny" data-act="save">Save</button> <button class="tiny warn" data-act="delete">Delete</button></td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No menu items yet.</p>';
}

async function menuAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('tr[data-item]');
  const x = current();
  const itemId = row.dataset.item;
  await busy(
    btn,
    async () => {
      let r;
      if (btn.dataset.act === 'avail') r = await api('PATCH', `/restaurants/${x.id}/menu/${itemId}/availability`, { body: { isAvailable: btn.dataset.v === 'true' } });
      if (btn.dataset.act === 'save') {
        const v = (f) => row.querySelector(`[data-f="${f}"]`).value;
        r = await api('PATCH', `/restaurants/${x.id}/menu/${itemId}`, { body: { name: v('name').trim(), description: v('description').trim(), price: toPaise(v('price')) } });
      }
      if (btn.dataset.act === 'delete') {
        if (!confirm('Delete this menu item?')) return;
        r = await api('DELETE', `/restaurants/${x.id}/menu/${itemId}`);
      }
      need(r.status < 300, errText(r));
      ok('menuMsg', btn.dataset.act === 'delete' ? 'Item deleted.' : 'Item updated.');
      await loadOwnerMenu();
    },
    'menuMsg',
  );
}

async function addItem(form, d) {
  const x = current();
  need(x, 'Select a restaurant');
  const r = await api('POST', `/restaurants/${x.id}/menu`, {
    body: { name: d.name.trim(), category: d.category.trim(), price: toPaise(d.price), isVeg: !!form.isVeg.checked, ...(d.description ? { description: d.description.trim() } : {}) },
  });
  need(r.status === 201, errText(r));
  form.reset();
  ok('menuMsg', `Added ${r.body.data.name}.`);
  await loadOwnerMenu();
}

async function loadRestaurantOrders() {
  const x = current();
  if (!x) return;
  const r = await api('GET', `/orders?restaurantId=${x.id}&limit=50`);
  if (r.status !== 200) return show('restaurantOrders', errText(r), true);
  $('restaurantOrders').innerHTML = r.body.data.length
    ? `<p class="muted">${esc(r.body.meta.total)} order(s)${r.body.meta.total > 50 ? ', newest 50 shown' : ''}</p><table><tr><th>Order</th><th>Placed</th><th>Items</th><th>Total</th><th>Status</th><th>Payment</th></tr>${r.body.data
        .map((o) => `<tr><td>${esc(o.orderNumber)}</td><td>${dateTime(o.createdAt)}</td><td>${esc(o.items.map((i) => `${i.quantity}× ${i.name}`).join(', '))}</td><td>${rupees(o.billing?.finalAmount ?? o.provisionalTotal)}</td><td>${pill(o.status, statusKind(o.status))}</td><td>${pill(o.paymentStatus, statusKind(o.paymentStatus))}</td></tr>`)
        .join('')}</table>`
    : '<p class="muted">No orders yet.</p>';
}

async function createRestaurant(form, d) {
  const cuisines = d.cuisines.split(',').map((c) => c.trim()).filter(Boolean);
  need(cuisines.length, 'Enter at least one cuisine');
  const r = await api('POST', '/restaurants', {
    body: {
      name: d.name.trim(),
      description: d.description.trim(),
      cuisines,
      address: { line1: d.line1.trim(), area: d.area.trim(), city: d.city.trim(), pincode: d.pincode.trim() },
      isPureVeg: !!form.isPureVeg.checked,
      costForTwo: toPaise(d.costForTwo),
      avgDeliveryMinutes: Number(d.avgDeliveryMinutes),
      ...(d.opens || d.closes ? { openingHours: { opens: d.opens || '10:00', closes: d.closes || '23:00' } } : {}),
      adminIds: selectedValues($('crAdmins')),
    },
  });
  need(r.status === 201, errText(r));
  form.reset();
  ok('createRestaurantMsg', `Created ${r.body.data.name} with ${r.body.data.adminIds?.length ?? 0} administrator(s). Its administrators add the menu.`);
  await loadAssignments();
  $('asgRestaurant').value = r.body.data.id;
  renderAssignments();
}

// ------------------------------------------------------------------ delivery agent
async function refreshAgent() {
  const r = await api('GET', '/deliveries/agents/me');
  if (r.status === 404) {
    show('agentProfile', '<p class="muted">Not registered as a partner yet: enter your phone and choose <b>Go available</b>.</p>');
    state.agentDelivery = null;
    renderAgentDelivery(null);
    return;
  }
  need(r.status === 200, errText(r));
  const a = r.body.data;
  if (!$('agentPhone').value) $('agentPhone').value = a.phone;
  show('agentProfile', `<dl class="kv"><dt>Status</dt><dd>${pill(a.status, statusKind(a.status))}</dd><dt>Phone</dt><dd>${esc(a.phone)}</dd><dt>Completed</dt><dd>${esc(a.completedDeliveries)} deliveries</dd></dl>`);
  state.agentDelivery = a.activeDelivery;
  renderAgentDelivery(a.activeDelivery);
}

function renderAgentDelivery(d) {
  if (!d) return show('agentDelivery', '<p class="muted">No active delivery. Stay available — assignments arrive automatically.</p>');
  const search = `${state.mailpitUrl}/search?q=${encodeURIComponent(`subject:"${d.orderNumber}"`)}`;
  show(
    'agentDelivery',
    `<dl class="kv"><dt>Order</dt><dd><b>${esc(d.orderNumber)}</b> ${pill(d.status, statusKind(d.status))}</dd>
     <dt>Pick up from</dt><dd>${esc(d.restaurantName)}</dd>
     <dt>Deliver to</dt><dd>${esc(d.customerName)} · ${esc([d.deliveryAddress?.line1, d.deliveryAddress?.city, d.deliveryAddress?.pincode].filter(Boolean).join(', '))}${d.deliveryAddress?.landmark ? ` (${esc(d.deliveryAddress.landmark)})` : ''}</dd>
     <dt>Items</dt><dd>${esc(d.items.map((i) => `${i.quantity}× ${i.name}`).join(', '))}</dd>
     ${d.otp ? `<dt>Code</dt><dd>${pill(d.otp.status)} expires ${time(d.otp.expiresAt)} · ${esc(d.otp.attemptsRemaining)} attempts left · ${esc(d.otpIssues)} issued</dd>` : ''}</dl>
     ${d.status === 'arrived' ? `<p class="muted">Local testing: the customer's code email is in <a href="${esc(search)}" target="_blank" rel="noopener">Mailpit</a>.</p>` : ''}`,
  );
}

async function setAvailability(available) {
  const phone = $('agentPhone').value.trim();
  const r = await api('PUT', '/deliveries/agents/me', { body: { available, ...(phone ? { phone } : {}) } });
  need(r.status === 200, errText(r));
  await refreshAgent();
}

async function agentAction(action, body) {
  need(state.agentDelivery, 'No active delivery');
  const r = await api('POST', `/deliveries/${state.agentDelivery.id}/${action}`, { body });
  if (r.status !== 200) return show('agentMsg', errText(r), true);
  ok('agentMsg', { pickup: 'Pickup confirmed.', arrived: 'Arrival reported — the customer has been emailed a code.', 'resend-otp': 'A new code was sent.', 'verify-otp': 'Code verified — delivery completed.' }[action]);
  if (action === 'verify-otp') $('otp').value = '';
  await refreshAgent();
}

// ------------------------------------------------------------------ customer: browse + order
async function loadRestaurants() {
  const r = await api('GET', '/restaurants?limit=50&isOpen=true&sort=rating');
  const list = r.body?.data ?? [];
  $('restaurantSelect').innerHTML = list.length ? list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.address?.city)} · ★${esc(x.rating)}</option>`).join('') : '<option value="">No open restaurants</option>';
  const d = await api('GET', '/discounts');
  $('discountSelect').innerHTML = '<option value="">No promo code</option>' + (d.body?.data ?? []).map((c) => `<option value="${esc(c.code)}">${esc(c.code)} — ${esc(c.description)}</option>`).join('');
}

async function loadMenu() {
  const id = $('restaurantSelect').value;
  need(id, 'Pick a restaurant');
  const r = await api('GET', `/restaurants/${id}/menu`);
  need(r.status === 200, errText(r));
  state.menu = r.body.data;
  $('menu').innerHTML = state.menu.items.length
    ? `<table><tr><th>Item</th><th>Price</th><th>Qty</th></tr>${state.menu.items
        .map((i) => `<tr><td>${pill(i.isVeg ? 'veg' : 'non-veg', i.isVeg ? 'ok' : 'bad')} ${esc(i.name)} <span class="muted">${esc(i.category)}</span>${i.isAvailable ? '' : ` ${pill('unavailable', 'bad')}`}</td><td>${rupees(i.price)}</td><td><input type="number" min="0" max="20" value="0" data-item="${esc(i.id)}" style="width:64px"${i.isAvailable ? '' : ' disabled'}></td></tr>`)
        .join('')}</table>`
    : '<p class="muted">This restaurant has no menu items yet.</p>';
}

async function placeOrder() {
  need(state.menu, 'Load a menu first');
  const items = [...document.querySelectorAll('#menu input[data-item]')].map((el) => ({ menuItemId: el.dataset.item, quantity: Number(el.value) })).filter((i) => i.quantity > 0);
  need(items.length, 'Choose at least one item (set a quantity)');
  const body = {
    restaurantId: state.menu.restaurant?.id ?? $('restaurantSelect').value,
    items,
    deliveryAddress: { line1: $('addrLine1').value.trim(), city: $('addrCity').value.trim(), pincode: $('addrPincode').value.trim() },
    ...($('discountSelect').value ? { discountCode: $('discountSelect').value } : {}),
  };
  let r;
  for (let i = 0; i < 10; i++) {
    r = await api('POST', '/orders', { body });
    if (r.status !== 503) break; // catalog read model still syncing
    await sleep(1500);
  }
  need(r.status === 201, errText(r));
  await selectOrder(r.body.data.id);
  await loadMyOrders();
}

async function loadMyOrders() {
  const r = await api('GET', '/orders?limit=20');
  if (r.status !== 200) return;
  $('myOrders').innerHTML = r.body.data.length
    ? `<table><tr><th>Order</th><th>Restaurant</th><th>Status</th><th></th></tr>${r.body.data
        .map((o) => `<tr><td>${esc(o.orderNumber)}<br><span class="muted">${dateTime(o.createdAt)}</span></td><td>${esc(o.restaurantName)}</td><td>${pill(o.status, statusKind(o.status))}</td><td><button class="tiny secondary" data-open="${esc(o.id)}">Open</button></td></tr>`)
        .join('')}</table>`
    : '<p class="muted">No orders yet.</p>';
}

async function selectOrder(id) {
  const r = await api('GET', `/orders/${id}`);
  need(r.status === 200, errText(r));
  state.order = r.body.data;
  state.payment = null;
  state.tracking = null;
  for (const el of ['invoice', 'payment', 'customerOtp', 'cancel', 'events']) $(el).innerHTML = '';
  renderOrder();
  void connectTracking();
  void refreshEvents();
}
function renderOrder() {
  const o = state.order;
  if (!o) return;
  show('orderInfo', `<dl class="kv"><dt>Order</dt><dd><b>${esc(o.orderNumber)}</b> <code>${esc(o.id)}</code></dd><dt>Status</dt><dd>${pill(o.status, statusKind(o.status))} payment ${pill(o.paymentStatus, statusKind(o.paymentStatus))}</dd><dt>Provisional total</dt><dd>${rupees(o.provisionalTotal)} <span class="muted">(subtotal ${rupees(o.subtotal)} + delivery ${rupees(o.deliveryFee)})</span></dd><dt>Pay before</dt><dd>${o.expiresAt ? dateTime(o.expiresAt) : '—'}</dd></dl>`);
}

// ------------------------------------------------------------------ customer: invoice, payment, code, cancel
async function loadInvoice() {
  need(state.order, 'Place or open an order first');
  for (let i = 0; i < 10; i++) {
    const r = await api('GET', `/invoices/order/${state.order.id}`);
    if (r.status === 200) {
      const v = r.body.data;
      return show('invoice', `<table>${v.lines.filter((l) => l.kind === 'item').map((l) => `<tr><td>${esc(l.quantity)} × ${esc(l.description)}</td><td>${rupees(l.lineTotal)}</td></tr>`).join('')}
        <tr><td>Delivery fee</td><td>${rupees(v.deliveryFee)}</td></tr>
        <tr><td>Discount ${esc(v.discount?.code ?? '')} ${v.discountRejection ? `<span class="err">rejected: ${esc(v.discountRejection.reason)}</span>` : ''}</td><td>− ${rupees(v.discountAmount)}</td></tr>
        <tr><td>Tax</td><td>${rupees(v.taxAmount)}</td></tr><tr><th>Final amount (charged)</th><th>${rupees(v.finalAmount)}</th></tr></table>
        <p class="muted">${esc(v.invoiceNumber)} · ${pill(v.status, statusKind(v.status))} · paid ${rupees(v.amountPaid)} · refunded ${rupees(v.amountRefunded)}</p>`);
    }
    await sleep(1000); // issued asynchronously from order.created
  }
  show('invoice', 'No invoice yet (Billing has not processed the order).', true);
}

async function initiate() {
  need(state.order, 'Place or open an order first');
  let r;
  for (let i = 0; i < 15; i++) {
    r = await api('POST', '/payments/initiate', { body: { orderId: state.order.id } });
    if (r.body?.error?.code !== 'BILLING_PENDING') break;
    show('payment', `<p class="muted">Waiting for the finalized bill (retry ${i + 1})…</p>`);
    await sleep(Number(r.headers.get('retry-after') ?? 2) * 1000);
  }
  need(r.status === 200 || r.status === 201, errText(r));
  state.payment = r.body.data.payment;
  renderPayment();
}
function renderPayment() {
  const p = state.payment;
  show('payment', `<dl class="kv"><dt>Payment</dt><dd>${pill(p.status, statusKind(p.status))} via ${esc(p.provider)}</dd><dt>Amount</dt><dd>${rupees(p.amount)} (invoice ${esc(p.invoiceNumber)})</dd>${p.lastFailure ? `<dt>Last failure</dt><dd class="err">${esc(p.lastFailure.code ?? '')} ${esc(p.lastFailure.message ?? '')}</dd>` : ''}<dt>Refunded</dt><dd>${rupees(p.refundedAmount)}</dd></dl>`);
}
async function simulate(outcome) {
  need(state.payment, 'Start the payment first');
  const r = await api('POST', `/payments/${state.payment.id}/simulate`, { body: { outcome } });
  need(r.status === 202, errText(r));
  for (let i = 0; i < 10; i++) {
    await sleep(800);
    const p = await api('GET', `/payments/order/${state.order.id}`);
    if (p.status === 200) {
      state.payment = p.body.data;
      renderPayment();
      if (['succeeded', 'failed'].includes(p.body.data.status)) break;
    }
  }
}

async function findOtp() {
  need(state.order, 'Open the order first');
  const mails = await dev(`/mail?to=${encodeURIComponent(state.session.user.email)}`);
  const mine = mails.filter((m) => /delivery code/i.test(m.subject) && m.subject.includes(state.order.orderNumber));
  need(mine.length, 'No delivery-code email for this order yet (it is sent when the partner reports arrival)');
  const msg = await dev(`/mail/${mine[0].id}`);
  const code = /Your delivery code is: (\d{6})/.exec(msg.text ?? '')?.[1];
  need(code, 'Could not read the code from the email');
  show('customerOtp', `<p>Your code for ${esc(state.order.orderNumber)}: <b class="otp">${esc(code)}</b> <span class="muted">(from "${esc(msg.subject)}", ${time(msg.created)})</span></p>`);
}

async function cancelOrder() {
  need(state.order, 'Place or open an order first');
  const reason = $('cancelReason').value.trim();
  need(reason.length >= 3, 'Enter a reason (at least 3 characters)');
  const r = await api('POST', `/orders/${state.order.id}/cancel`, { body: { reason } });
  if (r.status !== 200) return show('cancel', errText(r), true);
  state.order = r.body.data;
  renderOrder();
  show('cancel', `<p>Cancelled. Payment ${pill(r.body.data.paymentStatus)} — a paid order becomes <b>refunded</b> shortly (see live tracking).</p>`);
  await loadMyOrders();
}

// ------------------------------------------------------------------ live tracking (SSE over fetch with the Authorization header)
function renderTracking(t) {
  state.tracking = t;
  const steps = t.steps.map((s) => `<span class="step ${s.reached ? 'done' : ''} ${s.current ? 'current' : ''}" title="${esc(s.at ?? '')}">${esc(s.label)}</span>`).join('');
  $('tracking').innerHTML = `
    <dl class="kv"><dt>Order</dt><dd><b>${esc(t.orderNumber)}</b> ${pill(t.status, statusKind(t.status))} ${t.completed ? pill('completed', 'ok') : ''}</dd>
    <dt>Payment</dt><dd>${pill(t.paymentStatus, statusKind(t.paymentStatus))}</dd>
    <dt>Delivery</dt><dd>${t.deliveryStatus ? pill(t.deliveryStatus, statusKind(t.deliveryStatus)) : '—'} ${t.deliveryIssue ? `<span class="err">${esc(t.deliveryIssue)}</span>` : ''}</dd>
    <dt>Partner</dt><dd>${t.deliveryPartner ? `${esc(t.deliveryPartner.name)} · ${esc(t.deliveryPartner.phoneMasked ?? '')}` : '—'}</dd>
    ${t.deliveryCodeExpiresAt ? `<dt>Code expires</dt><dd>${time(t.deliveryCodeExpiresAt)}</dd>` : ''}</dl>
    <div class="steps">${steps}</div>
    <table><tr><th>#</th><th>Status</th><th>At</th><th>Source</th><th>Source event</th></tr>${t.history
      .map((h, i) => `<tr><td>${i + 1}</td><td>${esc(h.status)}</td><td>${time(h.at)}</td><td>${esc(h.sourceService ?? '')}</td><td class="mono">${esc(h.sourceEventId ?? '')}</td></tr>`)
      .join('')}</table>`;
  if (state.order) {
    state.order.status = t.status;
    state.order.paymentStatus = t.paymentStatus;
    renderOrder();
  }
}
async function connectTracking() {
  state.sse?.abort();
  const ctrl = new AbortController();
  state.sse = ctrl;
  const orderId = state.order.id;
  while (!ctrl.signal.aborted) {
    $('sseState').textContent = 'connecting…';
    try {
      const res = await fetch(`${state.gateway}/orders/${orderId}/tracking/stream`, { headers: { authorization: `Bearer ${token()}` }, signal: ctrl.signal });
      logLine('GET', `/orders/${orderId}/tracking/stream`, res.status, res.headers.get('x-request-id') ?? '', 0);
      if (res.status !== 200) throw new Error(`stream ${res.status}`);
      $('sseState').textContent = 'live (SSE)';
      $('sseState').className = 'pill ok';
      const reader = res.body.getReader();
      let buf = '';
      let ended = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.includes('event: end')) ended = true;
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (block.includes('event: tracking') && data) {
            renderTracking(JSON.parse(data));
            void refreshEvents();
            void refreshMail();
          }
        }
      }
      if (ended) {
        $('sseState').textContent = 'settled (stream ended)';
        $('sseState').className = 'pill';
        return;
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      $('sseState').textContent = `reconnecting (${err.message})`;
      $('sseState').className = 'pill warn';
    }
    await sleep(3000);
  }
}

// ------------------------------------------------------------------ observability panels
async function refreshEvents() {
  if (!state.order || role() !== 'customer') return;
  const r = await dev(`/events?orderId=${state.order.id}`);
  $('events').innerHTML = r.events.length
    ? `<table class="small"><tr><th>At</th><th>Event</th><th>Source</th><th>Summary</th><th>Event id / correlation id</th></tr>${r.events
        .map((e) => `<tr><td>${time(e.occurredAt)}</td><td>${esc(e.routingKey)}</td><td>${esc(e.source)}</td><td>${esc(e.summary ?? '')}</td><td class="mono">${esc(e.eventId)}<br><span class="muted">${esc(e.correlationId ?? '')}</span></td></tr>`)
        .join('')}</table>`
    : `<p class="muted">${r.tracing ? 'No events seen for this order yet.' : 'Event tracer not connected to RabbitMQ yet.'}</p>`;
}
async function refreshMail() {
  if (role() !== 'customer') return;
  const mails = await dev(`/mail?to=${encodeURIComponent(state.session.user.email)}`);
  $('mail').innerHTML = mails.length ? `<table>${mails.map((m) => `<tr><td>${time(m.created)}</td><td>${esc(m.subject)}</td></tr>`).join('')}</table>` : '<p class="muted">No emails yet.</p>';
}
async function refreshHealth() {
  const h = await dev('/health');
  const box = (name, status, extra = '') => `<div class="hbox"><b>${esc(name)}</b><br>${pill(status, statusKind(status))}${extra}</div>`;
  $('health').innerHTML = `<div class="health">${[h.gateway, ...h.services]
    .map((s) => box(s.name, s.status, Object.entries(s.checks).map(([k, v]) => `<br><span class="muted">${esc(k)}</span> ${esc(v)}`).join('')))
    .join('')}${box('rabbitmq', h.rabbitmq.status, h.rabbitmq.version ? `<br><span class="muted">v${esc(h.rabbitmq.version)} · ${esc(h.rabbitmq.connections)} conns</span>` : '')}${box('mailpit', h.mailpit.status, h.mailpit.messages !== undefined ? `<br><span class="muted">${esc(h.mailpit.messages)} emails</span>` : '')}${box('mongodb', h.mongo.startsWith('up') ? 'up' : 'down', `<br><span class="muted">${esc(h.mongo)}</span>`)}</div>`;
}
async function refreshQueues() {
  const qs = await dev('/queues');
  if (!Array.isArray(qs)) return show('queues', qs.error ?? 'RabbitMQ unavailable', true);
  const main = qs.filter((q) => q.kind === 'main');
  $('queues').innerHTML = `<table><tr><th>Queue</th><th>Ready</th><th>Consumers</th><th>DLQ</th></tr>${main
    .map((q) => {
      const dlq = qs.find((x) => x.name === `${q.name}.dlq`);
      return `<tr><td>${esc(q.name)}</td><td>${esc(q.messages)}</td><td>${q.consumers ? esc(q.consumers) : pill('0', 'bad')}</td><td>${dlq?.messages ? pill(dlq.messages, 'bad') : '0'}</td></tr>`;
    })
    .join('')}</table>`;
  const dl = await dev('/dlq');
  $('dlq').innerHTML = dl.length
    ? dl.map((d) => `<p><b>${esc(d.queue)}</b> ${pill(d.messages, 'bad')} ${esc(d.note ?? '')}</p>${d.items.map((m) => `<div class="small mono">${esc(m.eventType)} · ${esc(m.eventId)} · order ${esc(m.orderId ?? '—')} · retries ${esc(m.retries)}<br><span class="err">${esc(m.lastError)}</span></div>`).join('')}`).join('')
    : '<p class="okc">No dead-lettered messages.</p>';
}

// ------------------------------------------------------------------ wiring
async function init() {
  const cfg = await dev('/config');
  state.gateway = cfg.gatewayUrl;
  state.mailpitUrl = cfg.mailpitUrl;
  $('gw').textContent = cfg.gatewayUrl;
  $('mailpitLink').href = cfg.mailpitUrl;
  $('rabbitLink').href = cfg.rabbitmqUrl;
  applyRole();

  onSubmit('loginForm', login, 'accountMsg');
  onClick('btnLogout', async () => logout());

  $('createUserForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = $('createUserForm');
    // busy() re-enables the button when done; re-apply the permission state afterwards.
    void busy($('btnCreateUser'), () => createUser(form, formData(form)), 'createUserMsg').then(updateCreateUser);
  });
  $('createUserForm').role.addEventListener('change', updateCreateUser);
  onClick('btnUsers', loadUsers);
  $('userRoleFilter').addEventListener('change', () => void loadUsers().catch((e) => alert(e.message)));
  onClick('btnRetryAssign', async () => {
    await assignPending();
    await loadAssignments();
  }, 'createUserMsg');
  onClick('btnAssignments', loadAssignments, 'assignMsg');
  $('asgRestaurant').addEventListener('change', renderAssignments);
  onClick('btnAddAdmin', addRestaurantAdmin, 'assignMsg');
  $('asgList').addEventListener('click', (e) => {
    const userId = e.target.closest('button[data-remove]')?.dataset.remove;
    if (userId) void removeRestaurantAdmin(userId).catch((err) => show('assignMsg', err.message, true));
  });

  onClick('btnMyRestaurants', () => loadMyRestaurants($('myRestaurant').value));
  $('myRestaurant').addEventListener('change', () => void showMyRestaurant().catch((e) => alert(e.message)));
  onClick('btnToggleOpen', toggleOpen);
  onSubmit('editRestaurantForm', saveRestaurant, 'menuMsg');
  $('ownerMenu').addEventListener('click', (e) => void menuAction(e));
  onSubmit('addItemForm', addItem, 'menuMsg');
  onClick('btnRestaurantOrders', loadRestaurantOrders);
  onSubmit('createRestaurantForm', createRestaurant, 'createRestaurantMsg');

  onClick('btnAgentRefresh', refreshAgent, 'agentMsg');
  onClick('btnAvailable', () => setAvailability(true), 'agentMsg');
  onClick('btnOffline', () => setAvailability(false), 'agentMsg');
  onClick('btnPickup', () => agentAction('pickup'), 'agentMsg');
  onClick('btnArrived', () => agentAction('arrived'), 'agentMsg');
  onClick('btnResend', () => agentAction('resend-otp'), 'agentMsg');
  onClick('btnVerify', () => agentAction('verify-otp', { otp: $('otp').value.trim() }), 'agentMsg');

  onClick('btnLoadMenu', loadMenu);
  onClick('btnOrder', placeOrder, 'orderInfo');
  onClick('btnMyOrders', loadMyOrders);
  $('myOrders').addEventListener('click', (e) => {
    const id = e.target.closest('button[data-open]')?.dataset.open;
    if (id) void selectOrder(id).catch((err) => alert(err.message));
  });
  onClick('btnInvoice', loadInvoice, 'invoice');
  onClick('btnInitiate', initiate, 'payment');
  onClick('btnSucceed', () => simulate('succeed'), 'payment');
  onClick('btnFail', () => simulate('fail'), 'payment');
  onClick('btnFindOtp', findOtp, 'customerOtp');
  onClick('btnCancel', cancelOrder, 'cancel');

  onClick('btnEvents', refreshEvents);
  onClick('btnMail', refreshMail);
  onClick('btnHealth', refreshHealth);
  onClick('btnQueues', refreshQueues);

  await Promise.all([refreshHealth(), refreshQueues()]).catch(() => undefined);
  setInterval(() => void refreshHealth().catch(() => undefined), 10_000);
  setInterval(() => void refreshQueues().catch(() => undefined), 10_000);
  setInterval(() => void Promise.all([refreshEvents(), refreshMail()]).catch(() => undefined), 5_000);
  // Partners: pick up new assignments and state changes without clicking refresh.
  setInterval(() => role() === 'delivery_agent' && void refreshAgent().catch(() => undefined), 5_000);
}
void init();
