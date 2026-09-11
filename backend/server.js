// Minimal backend server exposing POST /api/chat.
// No frameworks, no database — order state lives in memory per session.
// Confirmed orders are appended to data/orders.json as a simple flat log.
// Requires Node 18+ (uses the built-in fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnvFile();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
// Defaults to Anthropic's current recommended general-purpose model; override via AI_MODEL in .env.
const MODEL = process.env.AI_MODEL || "claude-opus-5";
const MAX_TOKENS = 512;

// Simple flat config: TAX_RATE is a decimal fraction (e.g. 0.08 for 8%),
// DELIVERY_FEE is a flat dollar amount applied only to delivery orders.
const TAX_RATE = Number(process.env.TAX_RATE) || 0;
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE) || 0;

const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "prompts", "system-prompt.md");
const MENU_PATH = path.join(__dirname, "..", "data", "menu.json");
const PROMOTIONS_PATH = path.join(__dirname, "..", "data", "promotions.json");
// Dev-only order storage: a flat JSON file, no database. Revisit before production.
const ORDERS_PATH = path.join(__dirname, "..", "data", "orders.json");
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOOL_ITERATIONS = 4;

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readSystemPrompt() {
  try {
    return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  } catch {
    return "You are CafeBot, a helpful cafe assistant.";
  }
}

function readMenu() {
  try {
    return JSON.parse(fs.readFileSync(MENU_PATH, "utf8")).items || [];
  } catch {
    return [];
  }
}

function getMenuTool() {
  const activeItems = readMenu().filter((item) => item.available);
  return { ok: true, message: JSON.stringify(activeItems, null, 2) };
}

function readActivePromotions() {
  try {
    const promotions = JSON.parse(fs.readFileSync(PROMOTIONS_PATH, "utf8")).promotions || [];
    return promotions.filter((p) => p.active);
  } catch {
    return [];
  }
}

// Orders storage: reads/writes data/orders.json as a flat JSON array.
// This is for development/demo purposes only — plain file writes are not
// atomic or safe under concurrent requests, and platforms like Vercel run
// serverless functions on ephemeral/read-only filesystems, so writes here
// are not guaranteed to persist in production. Swap in a real database
// before deploying anywhere but a persistent single-process server.
function readOrders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  try {
    fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
  } catch (err) {
    // Read-only serverless filesystems (e.g. Vercel) can't persist this file —
    // don't let that take down order confirmation itself, just skip saving.
    console.error("writeOrders: failed to persist orders.json:", err.message);
  }
}

const STAFF_ORDER_STATUSES = ["NEW", "PREPARING", "READY", "COMPLETED", "CANCELLED"];

function buildSystemPrompt(order) {
  const menu = readMenu();
  const menuRules =
    "## Menu data\n" +
    "The only menu items, prices, sizes, options, allergens, dietary info, and " +
    "availability you may reference are listed in the JSON below. Never invent, " +
    "guess, or assume a menu item, price, or detail that is not explicitly present " +
    "here. If asked about something not listed, say it's not on the menu instead " +
    "of making something up. Some listed items have \"available\": false — these " +
    "are on the menu but not orderable right now; never describe one as available " +
    "or offer to add it, and if the customer asks about it or tries to order it, " +
    "tell them it's currently unavailable.\n\n" +
    JSON.stringify(menu, null, 2);

  const recommendationRules =
    "## Recommendations\n" +
    "You may recommend menu items when it fits naturally (e.g. the customer " +
    "asks for a suggestion, or something pairs well with what they just " +
    "ordered). Recommend at most 1-2 items at a time, only ones with " +
    "\"available\": true in the menu data above, and only ones actually " +
    "relevant to what the customer said. Never invent a product that isn't in " +
    "the menu data. Never pressure the customer — mention a recommendation " +
    "once, and if they decline or don't respond to it, drop it instead of " +
    "repeating or upselling further.";

  const promotionsRules =
    "## Promotions\n" +
    "These are the only currently active promotions. Only mention, recommend, " +
    "or apply a promotion listed here — never invent a discount or promotion " +
    "that isn't listed, and never mention one that isn't in this list (it is " +
    "inactive). Only recommend one if its eligibility rules look satisfied by " +
    "the current order. Apply one with apply_promotion, using its id from here " +
    "— the tool re-checks eligibility itself and will tell you if it isn't " +
    "actually eligible.\n\n" +
    JSON.stringify(readActivePromotions(), null, 2);

  const pickupRules =
    "## Pickup details\n" +
    "If the customer wants pickup, the order needs a customer name (required) " +
    "and may optionally have a requested pickup time. Set these with " +
    "set_pickup_details. Check the order details below first — only ask the " +
    "customer for whatever is still missing (e.g. don't ask for their name " +
    "again if it's already set there). Pickup time is optional: if the " +
    "customer doesn't offer one, don't press for it.";

  const deliveryRules =
    "## Delivery details\n" +
    "If the customer wants delivery, the order needs a customer name, phone " +
    "number, and full delivery address (all required). An apartment/unit " +
    "number and delivery instructions are optional — record them if the " +
    "customer offers them, but never ask for an apartment/unit unless the " +
    "address sounds like it needs one, and never press for delivery " +
    "instructions if they don't offer any. Set these with " +
    "set_delivery_details — check the order details below first and only ask " +
    "for whatever is still missing. Whenever the address or apartment/unit is " +
    "set or changed, you must read the full address back to the customer " +
    "yourself, word for word (including the apartment/unit if there is one), " +
    "and explicitly ask them to confirm it's correct. Only call " +
    "confirm_delivery_address after they clearly confirm it — a vague reply " +
    "like \"ok\" or \"sounds good\" is not enough, and the order details below " +
    "will show whether it's already confirmed. If they say anything about the " +
    "address is wrong, get the correct address and call set_delivery_details " +
    "again instead of confirming.";

  const orderingRules =
    "## Ordering\n" +
    "You can add items to the customer's order with add_item_to_order, change " +
    "an existing item's quantity, size, or options with update_order_item, " +
    "remove an item or reduce its quantity with remove_order_item (all using an " +
    "item's lineId from the current order below), apply an eligible active " +
    "promotion with apply_promotion (using its id from the Promotions section), " +
    "record pickup or delivery details with set_pickup_details, " +
    "set_delivery_details, and confirm_delivery_address, and, once the " +
    "customer is ready, review the order with get_order_summary and finalize " +
    "it with confirm_order. Before calling any of these tools, make sure you " +
    "have the exact details needed — especially size for items with a sizes " +
    "list, and a phone number plus an explicitly confirmed address for " +
    "delivery. Never guess a size, option, promotion, name, phone number, " +
    "address, or any other required detail; ask the customer first if " +
    "anything is missing or unclear.";

  const confirmationRules =
    "## Confirmation gate\n" +
    "Never treat an order as finalized until the customer has explicitly and " +
    "unambiguously confirmed it. The required flow: when the customer says " +
    "they're ready to check out or wants to review the order, call " +
    "get_order_summary and present everything it returns — items with " +
    "quantities and customizations, fulfillment details, any applied or other " +
    "valid promotions, and the total, exactly as returned. Never build this " +
    "summary yourself from memory or do any of the math.\n\n" +
    "Then wait for the customer's reply. Only call confirm_order if the reply " +
    "is a clear, explicit confirmation (e.g. \"yes\", \"that's correct\", " +
    "\"confirm it\"). Ambiguous, vague, or partial replies — \"ok\", \"sounds " +
    "good\", \"sure\", silence, or changing the subject — do NOT count as " +
    "confirmation; if their intent is unclear, ask them to confirm explicitly " +
    "instead of guessing. If they ask for any change instead, make the change " +
    "— confirm_order will refuse if the order changed since the last summary, " +
    "so call get_order_summary again and get a fresh confirmation afterward. " +
    "Never tell the customer their order is confirmed/finalized in words " +
    "alone — only confirm_order actually finalizes it, and its result is what " +
    "determines what really happened. Checkout (payment/fulfillment) itself " +
    "is not supported yet — once the order is confirmed, let them know that.";

  const currentOrder =
    "## Current order\n" +
    "Summary — use this, including quantities, customizations, and pickup or " +
    "delivery details, whenever the customer asks what's in their order (a " +
    "detail not shown below hasn't been provided yet). Every price and the " +
    "total (including tax and any delivery fee) are calculated by the system, " +
    "never by you — always read them from this summary or a tool result, and " +
    "never do the math or state a price/total yourself.\n\n" +
    summarizeOrder(order) +
    "\n\nRaw order data — use an item's lineId from here when calling " +
    "update_order_item or remove_order_item:\n\n" +
    JSON.stringify(order.items, null, 2);

  return `${readSystemPrompt()}\n\n${menuRules}\n\n${recommendationRules}\n\n${promotionsRules}\n\n${pickupRules}\n\n${deliveryRules}\n\n${orderingRules}\n\n${confirmationRules}\n\n${currentOrder}`;
}

const TOOLS = [
  {
    name: "getMenu",
    description:
      "Get the current menu: only items available to order right now, with their name, price, sizes, options, allergens, and dietary info. Use this to answer menu or pricing questions instead of guessing.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "add_item_to_order",
    description:
      "Add one menu item to the customer's current order. Only call this once you know the exact item, quantity, and — if the item has a sizes list — the chosen size. Do not guess; ask the customer first if anything required is missing.",
    input_schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "The exact id of the menu item from the menu data (e.g. \"coffee-latte\").",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description: "How many of this item to add.",
        },
        size: {
          type: "string",
          description: "The chosen size name (e.g. \"Medium\"). Required only if the item has a sizes list.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Chosen add-on options, matching the option text exactly as listed in the menu data.",
        },
      },
      required: ["itemId", "quantity"],
    },
  },
  {
    name: "update_order_item",
    description:
      "Change the quantity, size, and/or options of an item already in the customer's order. Requires the item's lineId from the current order data. Validate any new size or options against the menu data just like when adding an item — never guess.",
    input_schema: {
      type: "object",
      properties: {
        lineId: {
          type: "string",
          description: "The lineId of the order item to modify, from the current order data.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description: "New quantity for this item, if changing it.",
        },
        size: {
          type: "string",
          description: "New size name, if changing it. Only valid for items with a sizes list.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "The full replacement list of chosen options, if changing them.",
        },
      },
      required: ["lineId"],
    },
  },
  {
    name: "remove_order_item",
    description:
      "Remove an item from the customer's order, or reduce its quantity. Requires the item's lineId from the current order data. Omit quantity to remove the item entirely; provide quantity to reduce it by that amount (removing it entirely if that brings it to zero or below).",
    input_schema: {
      type: "object",
      properties: {
        lineId: {
          type: "string",
          description: "The lineId of the order item to remove or reduce, from the current order data.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description: "Amount to reduce the quantity by. Omit to remove the item entirely.",
        },
      },
      required: ["lineId"],
    },
  },
  {
    name: "apply_promotion",
    description:
      "Apply an active, currently-eligible promotion to the customer's order. Only call this for a promotion listed in the Promotions section, and only when its eligibility rules look satisfied by the current order. The tool re-checks eligibility itself and will reject the call if it isn't actually eligible right now.",
    input_schema: {
      type: "object",
      properties: {
        promotionId: {
          type: "string",
          description: "The exact id of the promotion to apply, from the Promotions section (e.g. \"promo-happy-hour\").",
        },
      },
      required: ["promotionId"],
    },
  },
  {
    name: "set_pickup_details",
    description:
      "Record the customer's name and, optionally, a requested pickup time for the order. A name is required before checkout; pickup time is optional. Only pass the fields you actually have new information for — omit customerName if it's already set in the current order and you're only adding/changing the pickup time, or vice versa. Never guess a name or time the customer didn't give.",
    input_schema: {
      type: "object",
      properties: {
        customerName: {
          type: "string",
          description: "The customer's name for the pickup order.",
        },
        pickupTime: {
          type: "string",
          description: "The customer's requested pickup time, e.g. \"3:30 PM\" or \"ASAP\". Optional.",
        },
      },
    },
  },
  {
    name: "set_delivery_details",
    description:
      "Record the customer's name, phone number, and/or delivery address (plus apartment/unit and delivery instructions, if given) for the order. Name, phone, and address are required before checkout for a delivery order; apartment/unit and delivery instructions are optional. Only pass the fields you actually have new information for — omit any field that's already set and unchanged. Never guess a name, phone number, address, apartment/unit, or delivery instructions the customer didn't give. After setting or changing the address or apartment/unit, you must read the full address back to the customer (including the apartment/unit, if any) and get their explicit confirmation or a correction before calling confirm_delivery_address.",
    input_schema: {
      type: "object",
      properties: {
        customerName: {
          type: "string",
          description: "The customer's name for the delivery order.",
        },
        phone: {
          type: "string",
          description: "The customer's phone number for the delivery order.",
        },
        address: {
          type: "string",
          description: "The full delivery address, exactly as given by the customer.",
        },
        apartment: {
          type: "string",
          description: "Apartment, suite, or unit number, if the customer has one. Optional.",
        },
        instructions: {
          type: "string",
          description: "Delivery instructions from the customer, e.g. a gate code or where to leave the order. Optional.",
        },
      },
    },
  },
  {
    name: "confirm_delivery_address",
    description:
      "Mark the current delivery address as explicitly confirmed by the customer. Only call this after you have read the full address back to them word for word and they have clearly confirmed it's correct — not just acknowledged the order in general. If they say anything about it is wrong, call set_delivery_details with the correction instead of calling this.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_order_summary",
    description:
      "Generate the complete, structured order summary for the customer to review before checkout: every item with its quantity and customizations, fulfillment details (pickup or delivery), any applied promotion plus any other currently-valid promotion, and the full total breakdown (subtotal, discount, tax, delivery fee, total). Call this when the customer wants to review the whole order or says they're ready to check out, then present it to them clearly and ask them to confirm everything is correct.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "viewCart",
    description:
      "Get a quick, itemized view of what's currently in the order right now: each item, its size, quantity, and customizations. No totals or pricing — use get_order_summary instead when the customer wants the full checkout review with pricing.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "confirm_order",
    description:
      "Finalize the order. Only call this after calling get_order_summary, presenting the full summary to the customer, and receiving a clear, explicit, unambiguous confirmation from them (e.g. \"yes\", \"that's correct\", \"confirm it\") — a vague reply like \"ok\", \"sounds good\", or \"sure\" does not count and must never be treated as confirmation; if their intent is unclear, ask them to confirm explicitly instead of calling this. The tool will refuse if the order is incomplete or if anything changed since the last summary (call get_order_summary again in that case).",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

function extractOptionPrice(optionText) {
  const match = /\+\s*\$?(\d+(?:\.\d+)?)/.exec(optionText);
  return match ? parseFloat(match[1]) : 0;
}

// categories, if given, scopes the subtotal to only items in those menu
// categories — used to correctly compute a category-specific percent
// discount (e.g. "20% off Coffee drinks") against just that category's
// items, instead of the whole order.
function calculateSubtotal(order, categories) {
  const menu = categories ? readMenu() : null;
  const subtotal = order.items.reduce((sum, item) => {
    if (categories) {
      const menuItem = menu.find((entry) => entry.id === item.itemId);
      if (!menuItem || !categories.includes(menuItem.category)) return sum;
    }
    const optionsCost = (item.options || []).reduce((s, opt) => s + extractOptionPrice(opt), 0);
    return sum + (item.unitPrice + optionsCost) * item.quantity;
  }, 0);
  return Math.round(subtotal * 100) / 100;
}

function getOrderCategories(order) {
  const menu = readMenu();
  const categories = new Set();
  for (const item of order.items) {
    const menuItem = menu.find((entry) => entry.id === item.itemId);
    if (menuItem) categories.add(menuItem.category);
  }
  return categories;
}

// subtotal is passed in (rather than recomputed) so this can be reused while
// a total is already being calculated, without risking recursion.
function isPromotionEligible(promotion, order, subtotal) {
  const eligibility = promotion.eligibility || {};
  const orderCategories = getOrderCategories(order);

  if (Array.isArray(eligibility.categories) && eligibility.categories.length > 0) {
    if (!eligibility.categories.some((c) => orderCategories.has(c))) {
      return { ok: false, reason: `requires an item from: ${eligibility.categories.join(", ")}` };
    }
  }

  if (Array.isArray(eligibility.requires_categories) && eligibility.requires_categories.length > 0) {
    const missing = eligibility.requires_categories.filter((c) => !orderCategories.has(c));
    if (missing.length > 0) {
      return { ok: false, reason: `requires items from: ${eligibility.requires_categories.join(", ")}` };
    }
  }

  if (eligibility.time_window) {
    const now = new Date();
    const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (current < eligibility.time_window.start || current > eligibility.time_window.end) {
      return {
        ok: false,
        reason: `only valid between ${eligibility.time_window.start} and ${eligibility.time_window.end}`,
      };
    }
  }

  if (typeof eligibility.min_order_total === "number" && subtotal < eligibility.min_order_total) {
    return { ok: false, reason: `requires an order total of at least $${eligibility.min_order_total.toFixed(2)}` };
  }

  return { ok: true };
}

// The only place order totals are computed. Every number here comes from
// data/menu.json prices, order quantities/options, data/promotions.json
// discounts, and the TAX_RATE/DELIVERY_FEE config — never from the AI.
function getOrderBreakdown(order) {
  const subtotal = calculateSubtotal(order);

  let discount = 0;
  if (order.promotion) {
    const promotion = readActivePromotions().find((p) => p.id === order.promotion);
    if (!promotion || !isPromotionEligible(promotion, order, subtotal).ok) {
      order.promotion = null;
    } else if (promotion.discount.type === "percent") {
      // A percent discount tied to specific eligibility categories (e.g.
      // "20% off Coffee drinks") applies only to that category's subtotal,
      // not the whole order — requires_categories-style bundle promos have
      // no category field here and fall back to the full subtotal.
      const eligibility = promotion.eligibility || {};
      const scopeCategories =
        Array.isArray(eligibility.categories) && eligibility.categories.length > 0
          ? eligibility.categories
          : null;
      const discountBase = scopeCategories ? calculateSubtotal(order, scopeCategories) : subtotal;
      discount = discountBase * (promotion.discount.value / 100);
    } else {
      discount = promotion.discount.value;
    }
  }
  discount = Math.round(discount * 100) / 100;

  const discountedSubtotal = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
  const tax = Math.round(discountedSubtotal * TAX_RATE * 100) / 100;
  const deliveryFee = order.orderType === "delivery" ? DELIVERY_FEE : 0;
  const total = Math.round((discountedSubtotal + tax + deliveryFee) * 100) / 100;

  // Keep order.total in sync every time a breakdown is computed (not just on
  // explicit mutations) — otherwise a stale cached total can disagree with
  // what get_order_summary / the system prompt just showed the customer.
  order.total = total;

  return { subtotal, discount, discountedSubtotal, tax, deliveryFee, total };
}

function calculateOrderTotal(order) {
  return getOrderBreakdown(order).total;
}

// Active promotions (other than the one already applied) whose eligibility
// rules the current order actually satisfies right now.
function getOtherValidPromotions(order, subtotal) {
  return readActivePromotions()
    .filter((p) => p.id !== order.promotion)
    .filter((p) => isPromotionEligible(p, order, subtotal).ok);
}

// A complete, structured, deterministic snapshot of the order — items,
// customizations, fulfillment details, valid promotions, and the full total
// breakdown — meant for reviewing the order before checkout. Every value is
// computed here from menu/promotion data and order state; nothing is left
// for the AI to calculate or invent.
function getOrderSummary(order) {
  const breakdown = getOrderBreakdown(order);

  // Generating a fresh summary is what the confirmation gate requires before
  // confirm_order will finalize the order — see markOrderChanged().
  order.summaryReviewed = true;

  const items = order.items.map((item) => {
    const optionsCost = (item.options || []).reduce((s, opt) => s + extractOptionPrice(opt), 0);
    return {
      name: item.name,
      size: item.size,
      quantity: item.quantity,
      customizations: item.options,
      lineTotal: Math.round((item.unitPrice + optionsCost) * item.quantity * 100) / 100,
    };
  });

  const fulfillment = {
    type: order.orderType,
    name: order.customer.name,
    phone: order.orderType === "delivery" ? order.customer.phone : null,
    pickupTime: order.orderType === "pickup" ? order.pickupTime : null,
    deliveryAddress: order.orderType === "delivery" ? order.deliveryAddress : null,
    deliveryApartment: order.orderType === "delivery" ? order.deliveryApartment : null,
    deliveryInstructions: order.orderType === "delivery" ? order.deliveryInstructions : null,
    addressConfirmed: order.orderType === "delivery" ? order.addressConfirmed : null,
  };

  const appliedPromotion = (() => {
    if (!order.promotion) return null;
    const promotion = readActivePromotions().find((p) => p.id === order.promotion);
    return promotion ? { id: promotion.id, name: promotion.name, discount: breakdown.discount } : null;
  })();

  const otherValidPromotions = getOtherValidPromotions(order, breakdown.subtotal).map((p) => ({
    id: p.id,
    name: p.name,
    rule: p.rule,
  }));

  return {
    items,
    fulfillment,
    appliedPromotion,
    otherValidPromotions,
    totals: {
      subtotal: breakdown.subtotal,
      discount: breakdown.discount,
      tax: breakdown.tax,
      deliveryFee: breakdown.deliveryFee,
      total: breakdown.total,
    },
  };
}

// A lightweight cart view: items, quantities, and customizations only — no
// pricing. Unlike getOrderSummary, this does not touch summaryReviewed, so
// it can't be used to satisfy the confirmation gate before checkout.
function viewCart(order) {
  return order.items.map((item) => ({
    name: item.name,
    size: item.size,
    quantity: item.quantity,
    customizations: item.options,
  }));
}

// Any action that changes the order invalidates the last summary the
// customer reviewed, and un-confirms an already-confirmed order — the
// confirmation gate (confirmOrder) requires a fresh summary and a fresh
// explicit confirmation after every change.
function markOrderChanged(order) {
  order.summaryReviewed = false;
  if (order.confirmed) {
    order.confirmed = false;
    order.status = "building";
  }
}

function summarizeOrder(order) {
  const details = [];
  if (order.orderType) details.push(`Order type: ${order.orderType}`);
  if (order.customer.name) details.push(`Name: ${order.customer.name}`);
  if (order.pickupTime) details.push(`Pickup time: ${order.pickupTime}`);
  if (order.orderType === "delivery" && order.customer.phone) {
    details.push(`Phone: ${order.customer.phone}`);
  }
  if (order.deliveryAddress) {
    const apartmentSuffix = order.deliveryApartment ? `, ${order.deliveryApartment}` : "";
    details.push(
      `Delivery address: ${order.deliveryAddress}${apartmentSuffix} (${
        order.addressConfirmed ? "confirmed" : "not yet confirmed"
      })`
    );
  }
  if (order.deliveryInstructions) details.push(`Delivery instructions: ${order.deliveryInstructions}`);
  if (order.confirmed) details.push("Status: confirmed");

  if (order.items.length === 0) {
    const emptyLine = "The order is currently empty.";
    return details.length ? `${details.join("\n")}\n${emptyLine}` : emptyLine;
  }

  const lines = order.items.map((item) => {
    const optionsCost = (item.options || []).reduce((s, opt) => s + extractOptionPrice(opt), 0);
    const lineTotal = Math.round((item.unitPrice + optionsCost) * item.quantity * 100) / 100;

    let line = `${item.quantity}x ${item.name}`;
    if (item.size) line += ` (${item.size})`;
    if (item.options.length) line += ` with ${item.options.join(", ")}`;
    line += ` — $${lineTotal.toFixed(2)}`;
    return line;
  });

  const breakdown = getOrderBreakdown(order);
  const totalsLines = [];
  const hasExtras = breakdown.discount > 0 || breakdown.tax > 0 || breakdown.deliveryFee > 0;

  if (hasExtras) {
    totalsLines.push(`Subtotal: $${breakdown.subtotal.toFixed(2)}`);
    if (breakdown.discount > 0 && order.promotion) {
      const promotion = readActivePromotions().find((p) => p.id === order.promotion);
      if (promotion) totalsLines.push(`Promotion applied: ${promotion.name} (-$${breakdown.discount.toFixed(2)})`);
    }
    if (breakdown.tax > 0) totalsLines.push(`Tax: $${breakdown.tax.toFixed(2)}`);
    if (breakdown.deliveryFee > 0) totalsLines.push(`Delivery fee: $${breakdown.deliveryFee.toFixed(2)}`);
  }
  totalsLines.push(`Total: $${breakdown.total.toFixed(2)}`);

  const otherValid = getOtherValidPromotions(order, breakdown.subtotal);
  if (otherValid.length > 0) {
    totalsLines.push(`Also valid for this order: ${otherValid.map((p) => p.name).join(", ")}`);
  }

  return [...details, ...lines, ...totalsLines].join("\n");
}

function addItemToOrder(order, input) {
  const { itemId, quantity, size, options } = input || {};

  if (typeof itemId !== "string" || !itemId.trim()) {
    return { ok: false, message: "itemId is required." };
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return { ok: false, message: "quantity must be a positive integer." };
  }

  const menuItem = readMenu().find((entry) => entry.id === itemId);
  if (!menuItem) {
    return { ok: false, message: `"${itemId}" is not a valid menu item id.` };
  }
  if (!menuItem.available) {
    return { ok: false, message: `${menuItem.name} is currently unavailable.` };
  }

  let unitPrice = menuItem.price;
  let sizeName = null;

  if (Array.isArray(menuItem.sizes) && menuItem.sizes.length > 0) {
    const sizeNames = menuItem.sizes.map((s) => s.name);
    if (typeof size !== "string" || !size.trim()) {
      return {
        ok: false,
        message: `${menuItem.name} requires a size. Available sizes: ${sizeNames.join(", ")}.`,
      };
    }
    const matchedSize = menuItem.sizes.find((s) => s.name.toLowerCase() === size.toLowerCase());
    if (!matchedSize) {
      return {
        ok: false,
        message: `"${size}" is not a valid size for ${menuItem.name}. Available sizes: ${sizeNames.join(", ")}.`,
      };
    }
    unitPrice = matchedSize.price;
    sizeName = matchedSize.name;
  }

  let chosenOptions = [];
  if (options !== undefined) {
    if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) {
      return { ok: false, message: "options must be an array of strings." };
    }
    const validOptions = menuItem.options || [];
    const invalidOptions = options.filter((o) => !validOptions.includes(o));
    if (invalidOptions.length > 0) {
      return {
        ok: false,
        message: `Invalid option(s) for ${menuItem.name}: ${invalidOptions.join(", ")}. Available options: ${
          validOptions.length ? validOptions.join(", ") : "none"
        }.`,
      };
    }
    chosenOptions = options;
  }

  order.items.push({
    lineId: crypto.randomUUID(),
    itemId: menuItem.id,
    name: menuItem.name,
    size: sizeName,
    quantity: qty,
    options: chosenOptions,
    unitPrice,
  });
  order.total = calculateOrderTotal(order);
  markOrderChanged(order);

  return {
    ok: true,
    message: `Added ${qty} x ${menuItem.name}${sizeName ? ` (${sizeName})` : ""} to the order.`,
  };
}

function updateOrderItem(order, input) {
  const { lineId, quantity, size, options } = input || {};

  if (typeof lineId !== "string" || !lineId.trim()) {
    return { ok: false, message: "lineId is required." };
  }

  const lineItem = order.items.find((item) => item.lineId === lineId);
  if (!lineItem) {
    return { ok: false, message: `No order item found with lineId "${lineId}".` };
  }

  if (quantity === undefined && size === undefined && options === undefined) {
    return { ok: false, message: "Provide quantity, size, and/or options to update." };
  }

  const menuItem = readMenu().find((entry) => entry.id === lineItem.itemId);
  if (!menuItem) {
    return { ok: false, message: `${lineItem.name} is no longer on the menu and can't be modified.` };
  }

  let newQuantity = lineItem.quantity;
  if (quantity !== undefined) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return { ok: false, message: "quantity must be a positive integer." };
    }
    newQuantity = qty;
  }

  let newUnitPrice = lineItem.unitPrice;
  let newSizeName = lineItem.size;
  if (size !== undefined) {
    if (!Array.isArray(menuItem.sizes) || menuItem.sizes.length === 0) {
      return { ok: false, message: `${menuItem.name} does not have size options.` };
    }
    const sizeNames = menuItem.sizes.map((s) => s.name);
    const matchedSize = menuItem.sizes.find((s) => s.name.toLowerCase() === String(size).toLowerCase());
    if (!matchedSize) {
      return {
        ok: false,
        message: `"${size}" is not a valid size for ${menuItem.name}. Available sizes: ${sizeNames.join(", ")}.`,
      };
    }
    newUnitPrice = matchedSize.price;
    newSizeName = matchedSize.name;
  }

  let newOptions = lineItem.options;
  if (options !== undefined) {
    if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) {
      return { ok: false, message: "options must be an array of strings." };
    }
    const validOptions = menuItem.options || [];
    const invalidOptions = options.filter((o) => !validOptions.includes(o));
    if (invalidOptions.length > 0) {
      return {
        ok: false,
        message: `Invalid option(s) for ${menuItem.name}: ${invalidOptions.join(", ")}. Available options: ${
          validOptions.length ? validOptions.join(", ") : "none"
        }.`,
      };
    }
    newOptions = options;
  }

  lineItem.quantity = newQuantity;
  lineItem.unitPrice = newUnitPrice;
  lineItem.size = newSizeName;
  lineItem.options = newOptions;
  order.total = calculateOrderTotal(order);
  markOrderChanged(order);

  return {
    ok: true,
    message: `Updated ${lineItem.name}${lineItem.size ? ` (${lineItem.size})` : ""}: quantity ${
      lineItem.quantity
    }${lineItem.options.length ? `, options: ${lineItem.options.join(", ")}` : ""}.`,
  };
}

function removeOrderItem(order, input) {
  const { lineId, quantity } = input || {};

  if (typeof lineId !== "string" || !lineId.trim()) {
    return { ok: false, message: "lineId is required." };
  }

  const index = order.items.findIndex((item) => item.lineId === lineId);
  if (index === -1) {
    return { ok: false, message: `No order item found with lineId "${lineId}".` };
  }

  const lineItem = order.items[index];
  const label = `${lineItem.name}${lineItem.size ? ` (${lineItem.size})` : ""}`;

  if (quantity === undefined) {
    order.items.splice(index, 1);
    order.total = calculateOrderTotal(order);
    markOrderChanged(order);
    return { ok: true, message: `Removed ${label} from the order.` };
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return { ok: false, message: "quantity must be a positive integer." };
  }

  const remaining = lineItem.quantity - qty;
  if (remaining <= 0) {
    order.items.splice(index, 1);
    order.total = calculateOrderTotal(order);
    markOrderChanged(order);
    return { ok: true, message: `Removed ${label} from the order.` };
  }

  lineItem.quantity = remaining;
  order.total = calculateOrderTotal(order);
  markOrderChanged(order);
  return { ok: true, message: `Reduced ${label} to quantity ${remaining}.` };
}

function applyPromotion(order, input) {
  const { promotionId } = input || {};

  if (typeof promotionId !== "string" || !promotionId.trim()) {
    return { ok: false, message: "promotionId is required." };
  }

  if (order.items.length === 0) {
    return { ok: false, message: "The order is empty, so no promotion can be applied yet." };
  }

  const promotion = readActivePromotions().find((p) => p.id === promotionId);
  if (!promotion) {
    return { ok: false, message: `"${promotionId}" is not a valid or currently active promotion.` };
  }

  const subtotal = calculateSubtotal(order);
  const eligibility = isPromotionEligible(promotion, order, subtotal);
  if (!eligibility.ok) {
    return { ok: false, message: `"${promotion.name}" is not eligible right now: ${eligibility.reason}.` };
  }

  order.promotion = promotion.id;
  order.total = calculateOrderTotal(order);
  markOrderChanged(order);

  return { ok: true, message: `Applied promotion "${promotion.name}". New total: $${order.total.toFixed(2)}.` };
}

function setPickupDetails(order, input) {
  const { customerName, pickupTime } = input || {};

  if (customerName === undefined && pickupTime === undefined) {
    return { ok: false, message: "Provide a customer name and/or a pickup time to set." };
  }

  let newName = order.customer.name;
  if (customerName !== undefined) {
    if (typeof customerName !== "string" || !customerName.trim()) {
      return { ok: false, message: "customerName must be a non-empty string." };
    }
    newName = customerName.trim();
  }

  let newPickupTime = order.pickupTime;
  if (pickupTime !== undefined) {
    if (typeof pickupTime !== "string" || !pickupTime.trim()) {
      return { ok: false, message: "pickupTime must be a non-empty string." };
    }
    newPickupTime = pickupTime.trim();
  }

  if (!newName) {
    return { ok: false, message: "A customer name is required for pickup orders." };
  }

  order.orderType = "pickup";
  order.customer.name = newName;
  order.pickupTime = newPickupTime;
  order.deliveryAddress = null;
  order.deliveryApartment = null;
  order.deliveryInstructions = null;
  order.addressConfirmed = false;
  order.total = calculateOrderTotal(order);
  markOrderChanged(order);

  return {
    ok: true,
    message: `Order set for pickup under the name "${order.customer.name}"${
      order.pickupTime ? `, pickup time: ${order.pickupTime}` : ""
    }.`,
  };
}

function setDeliveryDetails(order, input) {
  const { customerName, phone, address, apartment, instructions } = input || {};

  if (
    customerName === undefined &&
    phone === undefined &&
    address === undefined &&
    apartment === undefined &&
    instructions === undefined
  ) {
    return { ok: false, message: "Provide at least one delivery detail to set." };
  }

  let newName = order.customer.name;
  if (customerName !== undefined) {
    if (typeof customerName !== "string" || !customerName.trim()) {
      return { ok: false, message: "customerName must be a non-empty string." };
    }
    newName = customerName.trim();
  }

  let newPhone = order.customer.phone;
  if (phone !== undefined) {
    if (typeof phone !== "string" || !phone.trim()) {
      return { ok: false, message: "phone must be a non-empty string." };
    }
    newPhone = phone.trim();
  }

  let newAddress = order.deliveryAddress;
  let addressChanged = false;
  if (address !== undefined) {
    if (typeof address !== "string" || !address.trim()) {
      return { ok: false, message: "address must be a non-empty string." };
    }
    newAddress = address.trim();
    if (newAddress !== order.deliveryAddress) addressChanged = true;
  }

  let newApartment = order.deliveryApartment;
  if (apartment !== undefined) {
    if (typeof apartment !== "string" || !apartment.trim()) {
      return { ok: false, message: "apartment must be a non-empty string." };
    }
    newApartment = apartment.trim();
    if (newApartment !== order.deliveryApartment) addressChanged = true;
  }

  let newInstructions = order.deliveryInstructions;
  if (instructions !== undefined) {
    if (typeof instructions !== "string" || !instructions.trim()) {
      return { ok: false, message: "instructions must be a non-empty string." };
    }
    newInstructions = instructions.trim();
  }

  if (!newName) {
    return { ok: false, message: "A customer name is required for delivery orders." };
  }

  order.orderType = "delivery";
  order.customer.name = newName;
  order.customer.phone = newPhone;
  order.deliveryAddress = newAddress;
  order.deliveryApartment = newApartment;
  order.deliveryInstructions = newInstructions;
  order.pickupTime = null;
  if (addressChanged) {
    order.addressConfirmed = false;
  }
  order.total = calculateOrderTotal(order);
  markOrderChanged(order);

  return {
    ok: true,
    message: addressChanged
      ? `Delivery address set to "${order.deliveryAddress}"${
          order.deliveryApartment ? `, ${order.deliveryApartment}` : ""
        } for "${order.customer.name}". Read the full address back to the customer (including the apartment/unit, if any) and get their explicit confirmation (or a correction) — do not call confirm_delivery_address until they clearly confirm it.`
      : `Updated delivery details for "${order.customer.name}".`,
  };
}

// addressAtTurnStart/apartmentAtTurnStart are the address and apartment/unit
// as they existed before this request's tool calls ran — see the
// "snapshotted" comment in handleChat. Requiring both to match the current
// values means they must have been set in an earlier turn (and therefore
// actually shown to the customer, with a chance to reply) — not just-now by
// set_delivery_details in this same turn. Checking only the street address
// would let an apartment-only change slip through unconfirmed.
function confirmDeliveryAddress(order, addressAtTurnStart, apartmentAtTurnStart) {
  if (order.orderType !== "delivery") {
    return { ok: false, message: "The order isn't set for delivery yet." };
  }
  if (!order.deliveryAddress) {
    return { ok: false, message: "There's no delivery address to confirm yet." };
  }
  if (order.addressConfirmed) {
    return { ok: true, message: "The delivery address is already confirmed." };
  }
  if (order.deliveryAddress !== addressAtTurnStart || order.deliveryApartment !== apartmentAtTurnStart) {
    return {
      ok: false,
      message:
        "The address or apartment/unit was just set or changed in this same turn — read the full address (including apartment/unit) back to the customer and wait for their explicit confirmation in a new message before calling this.",
    };
  }

  order.addressConfirmed = true;
  markOrderChanged(order);
  return {
    ok: true,
    message: `Delivery address confirmed: "${order.deliveryAddress}"${
      order.deliveryApartment ? `, ${order.deliveryApartment}` : ""
    }.`,
  };
}

// Appends a confirmed order to data/orders.json (a plain JSON array — no
// database). Only ever called with an order whose status is already
// "confirmed", from inside confirmOrder's gated success path — never on a
// draft/building order.
function saveConfirmedOrder(order, sessionId) {
  if (order.status !== "confirmed") {
    throw new Error("saveConfirmedOrder called on an order that is not confirmed.");
  }

  const summary = getOrderSummary(order);
  const record = {
    orderId: crypto.randomUUID(),
    sessionId,
    status: "NEW",
    confirmedAt: new Date().toISOString(),
    items: summary.items,
    fulfillment: summary.fulfillment,
    appliedPromotion: summary.appliedPromotion,
    totals: summary.totals,
  };

  const orders = readOrders();
  orders.push(record);
  writeOrders(orders);

  return record.orderId;
}

// The confirmation gate: finalizes the order, but only if it's actually
// complete AND a summary was generated (via get_order_summary) since the
// last change — i.e. the customer could only have reviewed up-to-date
// information. Whether their reply was an unambiguous "yes" can't be
// verified here (that's a natural-language judgment enforced via the
// system prompt), but every structural precondition is enforced here.
// summaryReviewedAtTurnStart is whether get_order_summary had already run
// (with nothing changing since) BEFORE this request's tool calls started —
// see the "snapshotted" comment in handleChat. Checking the snapshot instead
// of the live order.summaryReviewed flag means the summary must have been
// shown to the customer in an earlier turn, giving them a real chance to
// reply — not just-now by get_order_summary in this same turn.
function confirmOrder(order, sessionId, summaryReviewedAtTurnStart) {
  if (order.items.length === 0) {
    return { ok: false, message: "The order is empty — there's nothing to confirm." };
  }
  if (!order.orderType || !order.customer.name) {
    return { ok: false, message: "Pickup or delivery details, including a name, must be set before the order can be confirmed." };
  }
  if (order.orderType === "delivery" && !order.customer.phone) {
    return { ok: false, message: "A phone number must be set before the order can be confirmed." };
  }
  if (order.orderType === "delivery" && (!order.deliveryAddress || !order.addressConfirmed)) {
    return { ok: false, message: "The delivery address must be set and explicitly confirmed before the order can be confirmed." };
  }
  if (!summaryReviewedAtTurnStart) {
    return {
      ok: false,
      message:
        "Call get_order_summary first, present it to the customer, and wait for their reply in a new message before confirming — either nothing has been reviewed yet, the order changed since, or the summary was only just generated this same turn.",
    };
  }
  if (order.confirmed) {
    return { ok: true, message: "The order is already confirmed." };
  }

  order.confirmed = true;
  order.status = "confirmed";
  order.orderId = saveConfirmedOrder(order, sessionId);

  return {
    ok: true,
    message: `Order confirmed for ${order.orderType} under the name "${order.customer.name}". Order ID: ${order.orderId}. Total: $${order.total.toFixed(2)}.`,
  };
}

// In-memory, session-based order state. No database — resets on server restart.
const orderSessions = new Map();

function createOrder() {
  return {
    items: [], // { lineId, itemId, name, size, quantity, options, unitPrice }
    orderType: null, // "pickup" | "delivery"
    customer: { name: null, phone: null, email: null },
    pickupTime: null, // optional, e.g. "3:30 PM" or "ASAP" — pickup orders only
    deliveryAddress: null, // required for delivery orders
    deliveryApartment: null, // optional — apartment/suite/unit number
    deliveryInstructions: null, // optional — e.g. gate code, where to leave the order
    addressConfirmed: false, // customer must explicitly confirm the delivery address
    promotion: null, // promotion id from data/promotions.json
    total: 0,
    summaryReviewed: false, // true once get_order_summary has run since the last change
    confirmed: false,
    status: "building", // "building" | "confirmed" | "cancelled"
    orderId: null, // set once saved to data/orders.json on confirmation
  };
}

function getOrCreateSession(sessionId) {
  if (typeof sessionId === "string" && orderSessions.has(sessionId)) {
    return { sessionId, order: orderSessions.get(sessionId) };
  }

  const id = crypto.randomUUID();
  const order = createOrder();
  orderSessions.set(id, order);
  return { sessionId: id, order };
}

function isValidHistory(history) {
  return (
    Array.isArray(history) &&
    history.every(
      (entry) =>
        entry &&
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string"
    )
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function handleChat(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    const { message, history, conversationHistory, sessionId: requestedSessionId } = parsed;
    // conversationHistory is accepted as an alias for history; history wins if both are sent.
    const chatHistory = history !== undefined ? history : conversationHistory !== undefined ? conversationHistory : [];

    if (typeof message !== "string" || !message.trim()) {
      return sendJson(res, 400, { error: "message is required and must be a non-empty string." });
    }
    if (!isValidHistory(chatHistory)) {
      return sendJson(res, 400, {
        error: "history (or conversationHistory) must be an array of { role: 'user' | 'assistant', content: string } messages.",
      });
    }
    if (!API_KEY || !MODEL) {
      return sendJson(res, 500, {
        error: "AI API is not configured. Set ANTHROPIC_API_KEY and AI_MODEL in .env.",
      });
    }

    const { sessionId, order } = getOrCreateSession(requestedSessionId);
    // Snapshotted before any tool call this request can run, so confirm_order
    // and confirm_delivery_address can only succeed on state that already
    // existed when the customer's message arrived — never on a summary or
    // address the AI just generated/set earlier in this same turn. This is
    // what actually enforces "after the customer reviews it in a reply" —
    // see confirmOrder() and confirmDeliveryAddress().
    const summaryReviewedAtTurnStart = order.summaryReviewed;
    const deliveryAddressAtTurnStart = order.deliveryAddress;
    const deliveryApartmentAtTurnStart = order.deliveryApartment;
    const messages = [...chatHistory, { role: "user", content: message }];

    try {
      let reply = "";

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const aiResponse = await fetch(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: buildSystemPrompt(order),
            tools: TOOLS,
            messages,
          }),
        });

        const data = await aiResponse.json();

        if (!aiResponse.ok) {
          return sendJson(res, 502, { error: data?.error?.message || "AI API request failed." });
        }

        const content = data?.content || [];
        messages.push({ role: "assistant", content });

        const toolUses = content.filter((block) => block.type === "tool_use");

        if (toolUses.length === 0) {
          reply = content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          break;
        }

        const toolResults = toolUses.map((toolUse) => {
          let result;
          if (toolUse.name === "getMenu") {
            result = getMenuTool();
          } else if (toolUse.name === "add_item_to_order") {
            result = addItemToOrder(order, toolUse.input);
          } else if (toolUse.name === "update_order_item") {
            result = updateOrderItem(order, toolUse.input);
          } else if (toolUse.name === "remove_order_item") {
            result = removeOrderItem(order, toolUse.input);
          } else if (toolUse.name === "apply_promotion") {
            result = applyPromotion(order, toolUse.input);
          } else if (toolUse.name === "set_pickup_details") {
            result = setPickupDetails(order, toolUse.input);
          } else if (toolUse.name === "set_delivery_details") {
            result = setDeliveryDetails(order, toolUse.input);
          } else if (toolUse.name === "confirm_delivery_address") {
            result = confirmDeliveryAddress(order, deliveryAddressAtTurnStart, deliveryApartmentAtTurnStart);
          } else if (toolUse.name === "get_order_summary") {
            result = { ok: true, message: JSON.stringify(getOrderSummary(order), null, 2) };
          } else if (toolUse.name === "viewCart") {
            result = { ok: true, message: JSON.stringify(viewCart(order), null, 2) };
          } else if (toolUse.name === "confirm_order") {
            result = confirmOrder(order, sessionId, summaryReviewedAtTurnStart);
          } else {
            result = { ok: false, message: "Unknown tool." };
          }

          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.message,
            is_error: !result.ok,
          };
        });

        messages.push({ role: "user", content: toolResults });
      }

      reply = reply || "Sorry, I couldn't finish that. Could you try again?";
      return sendJson(res, 200, { reply, sessionId, order });
    } catch (err) {
      console.error("handleChat failed:", err.message);
      return sendJson(res, 500, {
        error: "Sorry, I'm having trouble responding right now. Please try again in a moment.",
      });
    }
  });
}

// Staff dashboard endpoints: list confirmed orders and update their status.
// Read/writes data/orders.json directly — same file confirm_order appends to.
function handleGetOrders(req, res) {
  return sendJson(res, 200, { orders: readOrders() });
}

function handleUpdateOrderStatus(req, res, orderId) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    const { status } = parsed;
    if (!STAFF_ORDER_STATUSES.includes(status)) {
      return sendJson(res, 400, { error: `status must be one of: ${STAFF_ORDER_STATUSES.join(", ")}.` });
    }

    const orders = readOrders();
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) {
      return sendJson(res, 404, { error: `No order found with id "${orderId}".` });
    }

    order.status = status;
    writeOrders(orders);

    return sendJson(res, 200, { order });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    return handleChat(req, res);
  }

  if (req.method === "GET" && req.url === "/api/orders") {
    return handleGetOrders(req, res);
  }

  if (req.method === "PATCH" && req.url.startsWith("/api/orders/")) {
    const orderId = decodeURIComponent(req.url.slice("/api/orders/".length));
    return handleUpdateOrderStatus(req, res, orderId);
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, () => {
  console.log(`CafeBot backend listening on http://localhost:${PORT}`);
});
