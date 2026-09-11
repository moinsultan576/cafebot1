// Staff dashboard: reads/updates orders via the backend's /api/orders endpoints.
// Change this if the backend isn't running on its default port.
const API_BASE = "https://cafebot1.vercel.app";

const STATUSES = ["NEW", "PREPARING", "READY", "COMPLETED", "CANCELLED"];

const ordersList = document.getElementById("orders-list");
const emptyMessage = document.getElementById("empty-message");
const refreshBtn = document.getElementById("refresh-btn");

async function loadOrders() {
  ordersList.innerHTML = "<p>Loading…</p>";
  emptyMessage.hidden = true;

  try {
    const res = await fetch(`${API_BASE}/api/orders`);
    const data = await res.json();
    renderOrders(data.orders || []);
  } catch {
    ordersList.innerHTML = `<p class="error">Couldn't load orders. Is the backend running at ${API_BASE}?</p>`;
  }
}

function renderOrders(orders) {
  ordersList.innerHTML = "";

  if (orders.length === 0) {
    emptyMessage.hidden = false;
    return;
  }

  const sorted = [...orders].sort((a, b) => new Date(a.confirmedAt) - new Date(b.confirmedAt));
  for (const order of sorted) {
    ordersList.appendChild(renderOrderCard(order));
  }
}

function renderOrderCard(order) {
  const fulfillment = order.fulfillment || {};
  const totals = order.totals || {};
  const items = order.items || [];

  const card = document.createElement("div");
  card.className = "order-card";

  const itemLines = items
    .map((item) => {
      let line = `${item.quantity}x ${item.name}`;
      if (item.size) line += ` (${item.size})`;
      if (item.customizations && item.customizations.length) {
        line += ` — ${item.customizations.join(", ")}`;
      }
      return line;
    })
    .join("<br>");

  const fulfillmentLine =
    fulfillment.type === "delivery"
      ? `Delivery to ${fulfillment.deliveryAddress || "(no address)"}${
          fulfillment.deliveryApartment ? `, ${fulfillment.deliveryApartment}` : ""
        }`
      : `Pickup${fulfillment.pickupTime ? ` at ${fulfillment.pickupTime}` : ""}`;

  card.innerHTML = `
    <div class="order-header">
      <span class="order-id">#${order.orderId.slice(0, 8)}</span>
      <span class="badge badge-${order.status.toLowerCase()}">${order.status}</span>
    </div>
    <div class="order-time">${order.confirmedAt ? new Date(order.confirmedAt).toLocaleString() : ""}</div>
    <div class="order-items">${itemLines || "(no items)"}</div>
    <div class="order-fulfillment">
      <strong>${fulfillment.type || "unknown"}</strong> — ${fulfillment.name || "(no name)"}${
        fulfillment.phone ? ` · ${fulfillment.phone}` : ""
      }<br>
      ${fulfillmentLine}
    </div>
    <div class="order-total">Total: $${Number(totals.total || 0).toFixed(2)}</div>
  `;

  const statusRow = document.createElement("div");
  statusRow.className = "status-row";

  const label = document.createElement("label");
  label.textContent = "Status:";
  label.setAttribute("for", `status-${order.orderId}`);

  const select = document.createElement("select");
  select.id = `status-${order.orderId}`;
  for (const status of STATUSES) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    if (status === order.status) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => updateStatus(order.orderId, select.value, select));

  statusRow.appendChild(label);
  statusRow.appendChild(select);
  card.appendChild(statusRow);

  return card;
}

async function updateStatus(orderId, status, selectEl) {
  selectEl.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error("update failed");
    await loadOrders();
  } catch {
    alert("Couldn't update the order status. Please try again.");
    selectEl.disabled = false;
  }
}

refreshBtn.addEventListener("click", loadOrders);
loadOrders();
