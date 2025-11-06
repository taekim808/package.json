// Minimal Shopify App Proxy + Standing Orders job
// Env vars required (set on Render):
//   SHOP=fzn6nu-3j.myshopify.com
//   ADMIN_ACCESS_TOKEN=***
//   APP_PROXY_SHARED_SECRET=***
// Optional: PORT (Render sets this)

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const express = require("express");
const app = express();

app.get("/", (_req, res) => {
  res.send("Standing Order App backend is running ✅");
});

app.use(express.json());

// ---- Helpers
const { SHOP, ADMIN_ACCESS_TOKEN, APP_PROXY_SHARED_SECRET } = process.env;
if (!SHOP) console.warn("WARN: SHOP env var not set");
if (!ADMIN_ACCESS_TOKEN) console.warn("WARN: ADMIN_ACCESS_TOKEN env var not set");
if (!APP_PROXY_SHARED_SECRET) console.warn("WARN: APP_PROXY_SHARED_SECRET env var not set");

async function shopify(path, init = {}) {
  const url = `https://${SHOP}/admin/api/2024-10${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Shopify ${res.status} ${path}: ${txt}`);
  }
  return res.json();
}

// HMAC verify for App Proxy (signature query param)
function verifyProxy(req) {
  // Shopify sends ?signature=... and other query params; we must rebuild the string
  const { signature, ...params } = req.query;
  if (!signature) return false;
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('');
  const digest = crypto.createHmac('sha256', APP_PROXY_SHARED_SECRET).update(sorted).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(digest, 'hex'));
  } catch {
    return false;
  }
}

// ---- Health (for easy testing directly)
app.get("/health", (_req, res) => {
  res.json({ ok: true, shop: SHOP });
});

// ---- App Proxy: load saved standing orders for a customer
app.get("/proxy/standing-orders", async (req, res) => {
  try {
    if (!verifyProxy(req)) return res.status(401).json({ error: "invalid signature" });
    const customerId = req.query.customer_id;
    if (!customerId) return res.status(400).json({ error: "missing customer_id" });

    const json = await shopify(`/customers/${customerId}/metafields.json`);
    const mf = (json.metafields || []).find(m => m.namespace === "standing" && m.key === "weekly");
    res.json({ data: mf ? JSON.parse(m.value) : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- App Proxy: save standing orders JSON for a customer
app.post("/proxy/standing-orders", async (req, res) => {
  try {
    if (!verifyProxy(req)) return res.status(401).json({ error: "invalid signature" });
    const { customer_id, data } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: "missing customer_id" });

    const existing = await shopify(`/customers/${customer_id}/metafields.json`);
    const mf = (existing.metafields || []).find(m => m.namespace === "standing" && m.key === "weekly");

    if (mf) {
      await shopify(`/metafields/${mf.id}.json`, {
        method: "PUT",
        body: JSON.stringify({ metafield: { id: mf.id, type: "json", value: JSON.stringify(data) } })
      });
    } else {
      await shopify(`/metafields.json`, {
        method: "POST",
        body: JSON.stringify({
          metafield: {
            namespace: "standing",
            key: "weekly",
            owner_resource: "customer",
            owner_id: Number(customer_id),
            type: "json",
            value: JSON.stringify(data)
          }
        })
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Daily job: create Draft Orders for today's weekday
const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];

async function* iterateCustomers() {
  let page_info = null;
  do {
    const url = page_info
      ? `/customers.json?limit=250&page_info=${page_info}&fields=id`
      : `/customers.json?limit=250&fields=id`;
    const resp = await fetch(`https://${SHOP}/admin/api/2024-10${url}`, {
      headers: { "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN }
    });
    if (!resp.ok) throw new Error(`List customers failed: ${resp.status}`);
    const link = resp.headers.get('link') || '';
    const body = await resp.json();
    for (const c of body.customers || []) yield c.id;
    const next = link.match(/<[^>]+page_info=([^>]+)>; rel="next"/);
    page_info = next ? next[1] : null;
  } while (page_info);
}

async function getStanding(customerId) {
  const json = await shopify(`/customers/${customerId}/metafields.json`);
  const mf = (json.metafields || []).find(m => m.namespace === "standing" && m.key === "weekly");
  return mf ? JSON.parse(m.value) : null;
}

async function createDraftOrder(customerId, items, note) {
  const payload = {
    draft_order: {
      customer: { id: Number(customerId) },
      line_items: items.map(i => ({ variant_id: Number(i.variantId), quantity: Number(i.quantity) })),
      note,
      use_customer_default_address: true
    }
  };
  const res = await shopify(`/draft_orders.json`, { method: "POST", body: JSON.stringify(payload) });
  return res.draft_order;
}

app.post("/jobs/standing-orders/run", async (_req, res) => {
  try {
    const dayKey = DAY_KEYS[new Date().getDay()];
    const created = [];
    for await (const customerId of iterateCustomers()) {
      const data = await getStanding(customerId);
      if (!data || !Array.isArray(data.products)) continue;
      const items = data.products
        .map(p => ({ variantId: p.variantId, quantity: Number(p[dayKey] || 0) }))
        .filter(i => i.quantity > 0);
      if (items.length === 0) continue;
      const draft = await createDraftOrder(customerId, items, `Standing order for ${dayKey.toUpperCase()}`);
      // Optional: send invoice
      await shopify(`/draft_orders/${draft.id}/send_invoice.json`, {
        method: "POST",
        body: JSON.stringify({ draft_order_invoice: {} })
      });
      created.push({ customerId, draftId: draft.id });
    }
    res.json({ ok: true, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Standing Orders backend listening on ${port}`));
