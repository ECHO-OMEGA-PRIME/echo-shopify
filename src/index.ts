/**
 * ECHO SHOPIFY INTEGRATION WORKER v2.0.0
 * Echo Prime Technologies - Shopify Storefront + Admin API Bridge
 *
 * Handles:
 * - Shopify Storefront API proxy (product catalog, cart, checkout)
 * - Shopify Admin API proxy (order management, product sync)
 * - Webhook receiver (order.created, order.paid, order.fulfilled)
 * - Product sync between ept-api services and Shopify products
 * - Automatic fulfillment for digital services
 * - Analytics and sales tracking
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  ECHO_CHAT: Fetcher;
  SHARED_BRAIN: Fetcher;
  EPT_API: Fetcher;
  SHOPIFY_STORE_DOMAIN: string;
  SHOPIFY_STOREFRONT_TOKEN: string;
  SHOPIFY_ADMIN_TOKEN: string;
  SHOPIFY_WEBHOOK_SECRET: string;
  ECHO_API_KEY: string;
  STORE_DOMAIN: string;
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use('*', cors({
  origin: ['https://echo-ept.com', 'https://echo-prime-tech.vercel.app', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Echo-API-Key', 'X-Shopify-Hmac-Sha256'],
}));
// Security headers middleware
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});


// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(level: string, component: string, message: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, component, message, worker: 'echo-shopify', ...extra }));
}

// ─── Stripe Signature Verification (HMAC-SHA256, constant-time XOR, 5-min replay) ───
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const p of sigHeader.split(',')) { const eq = p.indexOf('='); if (eq > 0) parts[p.slice(0, eq).trim()] = p.slice(eq + 1).trim(); }
  const ts = parts['t']; const v1 = parts['v1'];
  if (!ts || !v1) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${payload}`));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== v1.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ─── Stripe API Helper ───
async function stripeAPI(env: Env, method: string, endpoint: string, body?: Record<string, string>): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`https://api.stripe.com/v1${endpoint}`, opts);
  return res.json();
}

// ─── Billing Plans ───
const SHOPIFY_PLANS: Record<string, { name: string; price: number; stores: number | 'unlimited'; products: number | 'unlimited' }> = {
  starter:    { name: 'Starter',    price: 2999,  stores: 1,          products: 500 },
  business:   { name: 'Business',   price: 7999,  stores: 5,          products: 5000 },
  enterprise: { name: 'Enterprise', price: 19999, stores: 'unlimited', products: 'unlimited' },
};

// ─── HEALTH ──────────────────────────────────────────────────────────────────

app.get("/", (c) => c.json({
  service: 'echo-shopify',
  version: '2.0.0',
  status: 'operational',
  description: 'Shopify E-Commerce Sync + Stripe Billing',
  billing: true,
}));

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '2.0.0',
    worker: 'echo-shopify',
    timestamp: new Date().toISOString(),
    shopify_store: c.env.SHOPIFY_STORE_DOMAIN || c.env.STORE_DOMAIN || 'not-configured',
    stripe_configured: !!(c.env.STRIPE_SECRET_KEY && c.env.STRIPE_WEBHOOK_SECRET),
    features: ['storefront-api', 'admin-api', 'webhooks', 'product-sync', 'auto-fulfillment', 'analytics', 'stripe-billing'],
  });
});

// ─── SHOPIFY STOREFRONT API PROXY ────────────────────────────────────────────

const STOREFRONT_API_VERSION = '2024-10';

async function storefrontQuery(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const rawDomain = env.SHOPIFY_STORE_DOMAIN || env.STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_TOKEN;
  if (!rawDomain || !token) {
    throw new Error('Shopify Storefront API not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_TOKEN secrets.');
  }
  // Handle both "store-name" and "store-name.myshopify.com" formats
  const host = rawDomain.includes('.myshopify.com') ? rawDomain : `${rawDomain}.myshopify.com`;
  const url = `https://${host}/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    log('error', 'storefront', 'Storefront API error', { status: resp.status, body: text });
    throw new Error(`Storefront API error: ${resp.status}`);
  }
  return resp.json();
}

// Get all products
app.get('/api/products', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    const cached = await c.env.CACHE.get('products:all', 'json');
    if (cached) return c.json(cached);

    const query = `{
      products(first: ${limit}) {
        edges {
          node {
            id
            title
            description
            descriptionHtml
            handle
            productType
            tags
            vendor
            availableForSale
            priceRange {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount currencyCode }
            }
            images(first: 3) {
              edges { node { url altText width height } }
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price { amount currencyCode }
                  availableForSale
                  selectedOptions { name value }
                }
              }
            }
            metafields(identifiers: [
              { namespace: "echo", key: "service_id" },
              { namespace: "echo", key: "tier" },
              { namespace: "echo", key: "features" }
            ]) { key value namespace }
          }
        }
      }
    }`;
    const data = await storefrontQuery(c.env, query);
    await c.env.CACHE.put('products:all', JSON.stringify(data), { expirationTtl: 300 });
    log('info', 'storefront', 'Products fetched', { count: (data as any)?.data?.products?.edges?.length || 0 });
    return c.json(data);
  } catch (e: any) {
    log('error', 'storefront', 'Failed to fetch products', { error: e.message });
    return c.json({ error: e.message, fallback: true, message: 'Shopify not configured yet — use ept-api services directly' }, 503);
  }
});

// Get single product by handle
app.get('/api/products/:handle', async (c) => {
  const handle = c.req.param('handle');
  try {
    const cached = await c.env.CACHE.get(`product:${handle}`, 'json');
    if (cached) return c.json(cached);

    const query = `query ProductByHandle($handle: String!) {
      product(handle: $handle) {
        id title description descriptionHtml handle productType tags vendor availableForSale
        priceRange { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
        images(first: 5) { edges { node { url altText width height } } }
        variants(first: 20) { edges { node { id title price { amount currencyCode } availableForSale selectedOptions { name value } } } }
        metafields(identifiers: [
          { namespace: "echo", key: "service_id" },
          { namespace: "echo", key: "tier" },
          { namespace: "echo", key: "features" },
          { namespace: "echo", key: "worker_url" }
        ]) { key value namespace }
      }
    }`;
    const data = await storefrontQuery(c.env, query, { handle });
    await c.env.CACHE.put(`product:${handle}`, JSON.stringify(data), { expirationTtl: 300 });
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 503);
  }
});

// ─── CART & CHECKOUT ─────────────────────────────────────────────────────────

// Create cart
app.post('/api/cart/create', async (c) => {
  try {
    const body = await c.req.json<{ lines?: Array<{ variantId: string; quantity: number }> }>().catch(() => ({ lines: [] }));
    const lines = body.lines || [];
    const query = `mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
          totalQuantity
          cost { totalAmount { amount currencyCode } subtotalAmount { amount currencyCode } }
          lines(first: 20) {
            edges { node { id quantity merchandise { ... on ProductVariant { id title price { amount currencyCode } product { title handle } } } } }
          }
        }
        userErrors { field message }
      }
    }`;
    const input: Record<string, unknown> = {};
    if (lines.length > 0) {
      input.lines = lines.map(l => ({ merchandiseId: l.variantId, quantity: l.quantity }));
    }
    const data = await storefrontQuery(c.env, query, { input });
    log('info', 'cart', 'Cart created', { lines: lines.length });
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Add to cart
app.post('/api/cart/:cartId/add', async (c) => {
  const cartId = decodeURIComponent(c.req.param('cartId'));
  try {
    const { lines } = await c.req.json<{ lines: Array<{ variantId: string; quantity: number }> }>();
    const query = `mutation cartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart {
          id checkoutUrl totalQuantity
          cost { totalAmount { amount currencyCode } }
          lines(first: 20) { edges { node { id quantity merchandise { ... on ProductVariant { id title price { amount currencyCode } } } } } }
        }
        userErrors { field message }
      }
    }`;
    const data = await storefrontQuery(c.env, query, {
      cartId,
      lines: lines.map(l => ({ merchandiseId: l.variantId, quantity: l.quantity })),
    });
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get cart
app.get('/api/cart/:cartId', async (c) => {
  const cartId = decodeURIComponent(c.req.param('cartId'));
  try {
    const query = `query cart($cartId: ID!) {
      cart(id: $cartId) {
        id checkoutUrl totalQuantity
        cost { totalAmount { amount currencyCode } subtotalAmount { amount currencyCode } totalTaxAmount { amount currencyCode } }
        lines(first: 20) { edges { node { id quantity merchandise { ... on ProductVariant { id title price { amount currencyCode } product { title handle } } } } } }
      }
    }`;
    const data = await storefrontQuery(c.env, query, { cartId });
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── SHOPIFY ADMIN API ───────────────────────────────────────────────────────

const ADMIN_API_VERSION = '2024-10';

async function adminQuery(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const rawDomain = env.SHOPIFY_STORE_DOMAIN || env.STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!rawDomain || !token) {
    throw new Error('Shopify Admin API not configured');
  }
  const host = rawDomain.includes('.myshopify.com') ? rawDomain : `${rawDomain}.myshopify.com`;
  const url = `https://${host}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    log('error', 'admin', 'Admin API error', { status: resp.status, body: text });
    throw new Error(`Admin API error: ${resp.status}`);
  }
  return resp.json();
}

// Auth check middleware for admin routes
async function requireAuth(c: any, next: () => Promise<void>) {
  const key = c.req.header('X-Echo-API-Key');
  if (key !== c.env.ECHO_API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}

// Sync products from ept-api services to Shopify
app.post('/api/admin/sync-products', requireAuth, async (c) => {
  try {
    // Fetch services via service binding
    const eptResp = await c.env.EPT_API.fetch('https://ept/api/services');
    if (!eptResp.ok) throw new Error(`ept-api error: ${eptResp.status}`);
    const eptRaw = await eptResp.json() as any;
    const services: any[] = Array.isArray(eptRaw) ? eptRaw : (eptRaw.services || eptRaw.data || []);

    const results: any[] = [];
    for (const svc of services) {
      // Create/update product in Shopify for each service
      for (const pricing of svc.pricing || []) {
        if (pricing.custom || pricing.price === null) continue;

        const productInput = {
          title: `${svc.name} - ${pricing.tier}`,
          descriptionHtml: `<p>${svc.description}</p><ul>${(svc.features || []).map((f: string) => `<li>${f}</li>`).join('')}</ul>`,
          productType: 'Digital Service',
          vendor: 'Echo Prime Technologies',
          tags: [svc.category || 'ai-service', pricing.tier, 'digital', 'subscription'],
          metafields: [
            { namespace: 'echo', key: 'service_id', value: svc.id, type: 'single_line_text_field' },
            { namespace: 'echo', key: 'tier', value: pricing.tier, type: 'single_line_text_field' },
            { namespace: 'echo', key: 'interval', value: pricing.interval || 'month', type: 'single_line_text_field' },
          ],
        };

        const query = `mutation productCreate($input: ProductInput!) {
          productCreate(input: $input) {
            product { id title handle }
            userErrors { field message }
          }
        }`;

        try {
          const result = await adminQuery(c.env, query, { input: productInput });
          results.push({ service: svc.id, tier: pricing.tier, result });
        } catch (e: any) {
          results.push({ service: svc.id, tier: pricing.tier, error: e.message });
        }
      }
    }

    log('info', 'admin', 'Product sync completed', { total: results.length, errors: results.filter(r => r.error).length });
    return c.json({ synced: results.length, results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get orders
app.get('/api/admin/orders', requireAuth, async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const query = `{
      orders(first: ${limit}, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id name email createdAt totalPriceSet { shopMoney { amount currencyCode } }
            displayFinancialStatus displayFulfillmentStatus
            lineItems(first: 10) { edges { node { title quantity variant { price } } } }
            metafields(first: 5) { edges { node { namespace key value } } }
          }
        }
      }
    }`;
    const data = await adminQuery(c.env, query);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── WEBHOOKS ────────────────────────────────────────────────────────────────

async function verifyShopifyWebhook(body: string, hmac: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === hmac;
}

app.post('/webhook/shopify', async (c) => {
  const body = await c.req.text();
  const hmac = c.req.header('X-Shopify-Hmac-Sha256') || '';
  const topic = c.req.header('X-Shopify-Topic') || '';

  // Verify webhook signature
  if (c.env.SHOPIFY_WEBHOOK_SECRET) {
    const valid = await verifyShopifyWebhook(body, hmac, c.env.SHOPIFY_WEBHOOK_SECRET);
    if (!valid) {
      log('warn', 'webhook', 'Invalid webhook signature', { topic });
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  const data = JSON.parse(body);
  log('info', 'webhook', `Webhook received: ${topic}`, { order_id: data.id });

  try {
    // Store webhook event in D1
    await c.env.DB.prepare(
      'INSERT INTO webhook_events (topic, shopify_id, payload, processed, created_at) VALUES (?, ?, ?, 0, datetime("now"))'
    ).bind(topic, String(data.id || ''), body).run();

    switch (topic) {
      case 'orders/create':
      case 'orders/paid':
        await handleOrderPaid(c.env, data);
        break;
      case 'orders/fulfilled':
        await handleOrderFulfilled(c.env, data);
        break;
      case 'orders/cancelled':
        await handleOrderCancelled(c.env, data);
        break;
      case 'app/uninstalled':
        log('warn', 'webhook', 'App uninstalled');
        break;
    }

    // Mark as processed
    await c.env.DB.prepare(
      'UPDATE webhook_events SET processed = 1 WHERE shopify_id = ? AND topic = ?'
    ).bind(String(data.id || ''), topic).run();

    return c.json({ received: true });
  } catch (e: any) {
    log('error', 'webhook', 'Webhook processing failed', { error: e.message, topic });
    return c.json({ error: e.message }, 500);
  }
});

async function handleOrderPaid(env: Env, order: any) {
  log('info', 'fulfillment', 'Processing paid order', { order_id: order.id, email: order.email, total: order.total_price });

  // Extract service info from line items
  for (const item of order.line_items || []) {
    const serviceId = item.properties?.find((p: any) => p.name === 'service_id')?.value;
    const tier = item.properties?.find((p: any) => p.name === 'tier')?.value;

    if (serviceId && tier) {
      // Create subscription in ept-api
      try {
        await env.EPT_API.fetch('https://ept/api/admin/activate-subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: order.email,
            service_id: serviceId,
            tier,
            shopify_order_id: order.id,
            shopify_order_name: order.name,
          }),
        });
        log('info', 'fulfillment', 'Subscription activated', { email: order.email, service: serviceId, tier });
      } catch (e: any) {
        log('error', 'fulfillment', 'Failed to activate subscription', { error: e.message, email: order.email });
      }
    }
  }

  // Store order in D1
  await env.DB.prepare(
    'INSERT OR REPLACE INTO orders (shopify_id, order_name, email, total_price, currency, financial_status, fulfillment_status, line_items, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))'
  ).bind(
    String(order.id), order.name, order.email,
    parseFloat(order.total_price || '0'), order.currency || 'USD',
    order.financial_status, order.fulfillment_status,
    JSON.stringify(order.line_items || [])
  ).run();

  // Notify Shared Brain
  try {
    await env.SHARED_BRAIN.fetch('https://brain/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: 'echo-shopify',
        role: 'system',
        content: `SHOPIFY ORDER PAID: ${order.name} from ${order.email} — $${order.total_price} ${order.currency}. Items: ${(order.line_items || []).map((i: any) => i.title).join(', ')}`,
        importance: 8,
        tags: ['shopify', 'order', 'revenue'],
      }),
    });
  } catch { /* best effort */ }
}

async function handleOrderFulfilled(env: Env, order: any) {
  log('info', 'fulfillment', 'Order fulfilled', { order_id: order.id });
  await env.DB.prepare(
    'UPDATE orders SET fulfillment_status = ? WHERE shopify_id = ?'
  ).bind('fulfilled', String(order.id)).run();
}

async function handleOrderCancelled(env: Env, order: any) {
  log('info', 'fulfillment', 'Order cancelled', { order_id: order.id });
  await env.DB.prepare(
    'UPDATE orders SET financial_status = ?, fulfillment_status = ? WHERE shopify_id = ?'
  ).bind('refunded', 'cancelled', String(order.id)).run();
}

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

app.get('/api/analytics/sales', requireAuth, async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '30');
    const stats = await c.env.DB.prepare(`
      SELECT
        COUNT(*) as total_orders,
        SUM(total_price) as total_revenue,
        AVG(total_price) as avg_order_value,
        COUNT(DISTINCT email) as unique_customers
      FROM orders
      WHERE created_at >= datetime('now', '-' || ? || ' days')
    `).bind(days).first();

    const byDay = await c.env.DB.prepare(`
      SELECT date(created_at) as date, COUNT(*) as orders, SUM(total_price) as revenue
      FROM orders
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
      ORDER BY date DESC
    `).bind(days).all();

    const topProducts = await c.env.DB.prepare(`
      SELECT line_items, COUNT(*) as order_count
      FROM orders
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY line_items
      ORDER BY order_count DESC
      LIMIT 10
    `).bind(days).all();

    return c.json({ period: `${days}d`, stats, daily: byDay.results, top_products: topProducts.results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── EPT-API CATALOG HELPER ──────────────────────────────────────────────────
// Fetches via external URL (not service binding) to avoid CF binding timeout.
// Called by cron every 6h to pre-populate KV, and as fallback on cache miss.

// Fetches EPT catalog. Pass env to use service binding (required for same-account workers).
async function fetchEptCatalog(env?: Env): Promise<any | null> {
  try {
    let resp: Response;
    if (env?.EPT_API) {
      resp = await env.EPT_API.fetch('https://ept/api/services');
    } else {
      resp = await fetch('https://ept-api.bmcii1976.workers.dev/api/services');
    }
    if (!resp.ok) {
      log('error', 'catalog', 'ept-api fetch failed', { status: resp.status });
      return null;
    }
    const raw = await resp.json() as any;
    // ept-api returns { services: [...] } or a raw array
    const services: any[] = Array.isArray(raw) ? raw : (raw.services || raw.data || []);
    if (!services.length) {
      log('warn', 'catalog', 'ept-api returned 0 services', { raw_type: typeof raw, keys: Object.keys(raw || {}) });
      return null;
    }

    const products = services.map((svc: any) => ({
      id: svc.id,
      title: svc.name,
      description: svc.description,
      handle: svc.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      category: svc.category || 'ai-service',
      features: svc.features || [],
      available: true,
      variants: (svc.pricing || []).filter((p: any) => !p.custom && p.price !== null).map((p: any) => ({
        id: `${svc.id}-${p.tier}`,
        title: p.tier,
        price: { amount: String(p.price), currencyCode: 'USD' },
        interval: p.interval || 'month',
        available: true,
      })),
      priceRange: {
        min: Math.min(...(svc.pricing || []).filter((p: any) => p.price).map((p: any) => p.price)),
        max: Math.max(...(svc.pricing || []).filter((p: any) => p.price).map((p: any) => p.price)),
        currency: 'USD',
      },
    }));

    return {
      source: 'ept-api',
      total: products.length,
      products,
      categories: [...new Set(products.map((p: any) => p.category))],
      shopify_configured: false,
      cached_at: new Date().toISOString(),
      message: 'Serving from ept-api. Shopify integration pending API key setup.',
    };
  } catch (e: any) {
    log('error', 'catalog', 'fetchEptCatalog failed', { error: e.message });
    return null;
  }
}

// When Shopify tokens aren't set yet, serve products directly from ept-api
// so the ecommerce page can display the catalog immediately

app.get('/api/catalog', async (c) => {
  try {
    // Try Shopify Storefront API first if configured
    if (c.env.SHOPIFY_STOREFRONT_TOKEN) {
      const cacheKey = 'catalog:shopify';
      const cached = await c.env.CACHE.get(cacheKey, 'json');
      if (cached) return c.json(cached);

      try {
        const query = `{
          products(first: 50) {
            edges {
              node {
                id title description handle productType tags vendor availableForSale
                priceRange { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
                variants(first: 10) { edges { node { id title price { amount currencyCode } availableForSale selectedOptions { name value } } } }
                metafields(identifiers: [{ namespace: "echo", key: "service_id" }, { namespace: "echo", key: "category" }]) { key value namespace }
              }
            }
          }
        }`;
        const raw = await storefrontQuery(c.env, query);
        const edges = (raw as any)?.data?.products?.edges || [];
        const products = edges.map((e: any) => {
          const n = e.node;
          const serviceId = n.metafields?.find((m: any) => m?.key === 'service_id')?.value;
          const category = n.metafields?.find((m: any) => m?.key === 'category')?.value || n.productType;
          return {
            id: serviceId || n.handle,
            title: n.title,
            description: n.description,
            handle: n.handle,
            product_type: n.productType,
            category,
            tags: n.tags,
            available: n.availableForSale,
            price_range: n.priceRange,
            variants: (n.variants?.edges || []).map((v: any) => ({
              id: v.node.id,
              title: v.node.title,
              price: v.node.price?.amount,
              currency: v.node.price?.currencyCode,
              available: v.node.availableForSale,
              options: v.node.selectedOptions,
            })),
            checkout_url: `https://echo-ept.com/checkout?service=${serviceId || n.handle}`,
          };
        });
        const catalog = {
          source: 'shopify',
          total: products.length,
          products,
          categories: [...new Set(products.map((p: any) => p.category).filter(Boolean))],
          cached_at: new Date().toISOString(),
        };
        await c.env.CACHE.put(cacheKey, JSON.stringify(catalog), { expirationTtl: 21600 });
        log('info', 'catalog', 'Shopify catalog served', { count: products.length });
        return c.json(catalog);
      } catch (sfErr: any) {
        log('warn', 'catalog', 'Shopify Storefront query failed, falling back to ept-api', { error: sfErr.message });
      }
    }

    // Fallback: serve from KV cache or ept-api service binding
    const cached = await c.env.CACHE.get('catalog:ept', 'json');
    if (cached) return c.json(cached);

    const catalog = await fetchEptCatalog(c.env);
    if (catalog) {
      await c.env.CACHE.put('catalog:ept', JSON.stringify(catalog), { expirationTtl: 21600 });
      log('info', 'catalog', 'Cached ept-api catalog on first request', { count: catalog.total });
      return c.json(catalog);
    }

    return c.json({ error: 'Catalog unavailable', source: 'error', products: [] }, 503);
  } catch (e: any) {
    log('error', 'catalog', 'Catalog fetch failed', { error: e.message });
    return c.json({ error: e.message, source: 'error', products: [] }, 500);
  }
});

// Get single product from catalog by handle
app.get('/api/catalog/:handle', async (c) => {
  const handle = c.req.param('handle');
  try {
    // Try Shopify first
    if (c.env.SHOPIFY_STOREFRONT_TOKEN) {
      const cached = await c.env.CACHE.get(`product:${handle}`, 'json');
      if (cached) return c.json({ source: 'shopify', ...(cached as object) });
    }

    // Use cached catalog from KV first
    const cached = await c.env.CACHE.get('catalog:ept', 'json') as any;
    if (cached?.products) {
      const product = cached.products.find((p: any) =>
        p.handle === handle || p.id?.toLowerCase() === handle.toLowerCase()
      );
      if (product) return c.json({ source: 'ept-api', product: { ...product, checkout_url: `https://echo-ept.com/checkout?service=${product.id}` } });
    }

    // Fallback: fetch via service binding
    const catalog = await fetchEptCatalog(c.env);
    if (catalog?.products) {
      const product = catalog.products.find((p: any) =>
        p.handle === handle || p.id?.toLowerCase() === handle.toLowerCase()
      );
      if (product) return c.json({ source: 'ept-api', product: { ...product, checkout_url: `https://echo-ept.com/checkout?service=${product.id}` } });
    }

    return c.json({ error: 'Product not found' }, 404);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── CONFIG STATUS ──────────────────────────────────────────────────────

app.get('/api/admin/config', requireAuth, async (c) => {
  const shopifyConfigured = !!(c.env.SHOPIFY_STOREFRONT_TOKEN && c.env.SHOPIFY_ADMIN_TOKEN);
  const storeDomain = c.env.SHOPIFY_STORE_DOMAIN || c.env.STORE_DOMAIN || 'not-set';
  return c.json({
    shopify: {
      configured: shopifyConfigured,
      store_domain: storeDomain,
      storefront_token: c.env.SHOPIFY_STOREFRONT_TOKEN ? '***set***' : 'NOT SET',
      admin_token: c.env.SHOPIFY_ADMIN_TOKEN ? '***set***' : 'NOT SET',
      webhook_secret: c.env.SHOPIFY_WEBHOOK_SECRET ? '***set***' : 'NOT SET',
    },
    integrations: {
      ept_api: 'connected (service binding)',
      echo_chat: 'connected (service binding)',
      shared_brain: 'connected (service binding)',
    },
    worker: {
      version: '2.0.0',
      d1_database: 'echo-shopify',
      kv_namespace: 'CACHE',
      crons: ['0 */6 * * * (catalog sync)', '0 14 * * * (daily report)'],
    },
    setup_steps: shopifyConfigured ? ['All configured'] : [
      '1. Create Shopify store at shopify.com (free trial)',
      '2. Go to Settings > Apps > Develop Apps > Create App',
      '3. Name: "Echo Prime Storefront", configure all Storefront API + Admin API scopes',
      '4. Install the app, reveal tokens',
      `5. Run: echo "YOUR_DOMAIN" | npx wrangler secret put SHOPIFY_STORE_DOMAIN`,
      `6. Run: echo "shpat_xxx" | npx wrangler secret put SHOPIFY_ADMIN_TOKEN`,
      `7. Run: echo "xxx" | npx wrangler secret put SHOPIFY_STOREFRONT_TOKEN`,
      `8. Run: echo "whsec_xxx" | npx wrangler secret put SHOPIFY_WEBHOOK_SECRET`,
      '9. Hit POST /api/admin/register-webhooks to register webhook listeners',
    ],
  });
});

// ─── WEBHOOK REGISTRATION ───────────────────────────────────────────────

app.post('/api/admin/register-webhooks', requireAuth, async (c) => {
  try {
    if (!c.env.SHOPIFY_ADMIN_TOKEN) {
      return c.json({ error: 'SHOPIFY_ADMIN_TOKEN not set — configure Shopify first' }, 400);
    }

    const webhookTopics = [
      'ORDERS_CREATE', 'ORDERS_PAID', 'ORDERS_FULFILLED', 'ORDERS_CANCELLED', 'APP_UNINSTALLED',
    ];
    const callbackUrl = 'https://echo-shopify.bmcii1976.workers.dev/webhook/shopify';
    const results: any[] = [];

    for (const topic of webhookTopics) {
      const query = `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
          userErrors { field message }
        }
      }`;
      try {
        const result = await adminQuery(c.env, query, {
          topic,
          webhookSubscription: { callbackUrl, format: 'JSON' },
        });
        results.push({ topic, result });
      } catch (e: any) {
        results.push({ topic, error: e.message });
      }
    }

    log('info', 'admin', 'Webhooks registered', { count: results.length });
    return c.json({ registered: results.length, results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── AUTO-FULFILLMENT (for digital products) ────────────────────────────

app.post('/api/admin/fulfill/:orderId', requireAuth, async (c) => {
  const orderId = c.req.param('orderId');
  try {
    if (!c.env.SHOPIFY_ADMIN_TOKEN) {
      return c.json({ error: 'Admin API not configured' }, 400);
    }

    // Get fulfillment order
    const foQuery = `query ($orderId: ID!) {
      order(id: $orderId) {
        fulfillmentOrders(first: 5) {
          edges { node { id status lineItems(first: 20) { edges { node { id totalQuantity } } } } }
        }
      }
    }`;
    const foData = await adminQuery(c.env, foQuery, { orderId: `gid://shopify/Order/${orderId}` }) as any;
    const fulfillmentOrders = foData?.data?.order?.fulfillmentOrders?.edges || [];

    const results: any[] = [];
    for (const fo of fulfillmentOrders) {
      if (fo.node.status !== 'OPEN') continue;
      const fulfillQuery = `mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`;
      const lineItems = fo.node.lineItems.edges.map((li: any) => ({
        id: li.node.id,
        quantity: li.node.totalQuantity,
      }));
      const result = await adminQuery(c.env, fulfillQuery, {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.node.id, fulfillmentOrderLineItems: lineItems }],
          notifyCustomer: true,
          trackingInfo: { company: 'Echo Prime Technologies', number: `ECHO-${orderId}`, url: 'https://echo-ept.com/dashboard' },
        },
      });
      results.push(result);
    }

    log('info', 'fulfillment', 'Digital order fulfilled', { order_id: orderId, fulfillments: results.length });
    return c.json({ fulfilled: results.length, results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── STATS ───────────────────────────────────────────────────────────────────

app.get('/stats', async (c) => {
  try {
    const orders = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM orders').first<{ cnt: number }>();
    const webhooks = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM webhook_events').first<{ cnt: number }>();
    const revenue = await c.env.DB.prepare('SELECT SUM(total_price) as total FROM orders WHERE financial_status = "paid"').first<{ total: number }>();
    return c.json({
      total_orders: orders?.cnt || 0,
      total_webhooks: webhooks?.cnt || 0,
      total_revenue: revenue?.total || 0,
      currency: 'USD',
    });
  } catch (e: any) {
    return c.json({ error: e.message, orders: 0, webhooks: 0, revenue: 0 });
  }
});

// ─── CRON ────────────────────────────────────────────────────────────────────

async function handleCron(env: Env) {
  log('info', 'cron', 'Running scheduled sync');

  // Refresh EPT catalog in KV via service binding
  try {
    const catalog = await fetchEptCatalog(env);
    if (catalog) {
      await env.CACHE.put('catalog:ept', JSON.stringify(catalog), { expirationTtl: 21600 }); // 6h
      log('info', 'cron', 'EPT catalog cached', { products: catalog.total });
    }
  } catch (e: any) {
    log('error', 'cron', 'Failed to cache EPT catalog', { error: e.message });
  }

  // Invalidate Shopify product cache (will be re-fetched on next request)
  await env.CACHE.delete('products:all');
}

// ═══════════════════════════════════════════════════════════════
// ─── Stripe Billing Endpoints ───
// ═══════════════════════════════════════════════════════════════

// ─── GET /plans ───
app.get('/plans', (c) => {
  const plans = Object.entries(SHOPIFY_PLANS).map(([id, p]) => ({
    id,
    name: p.name,
    price_cents: p.price,
    price_display: `$${(p.price / 100).toFixed(2)}/mo`,
    stores: p.stores,
    products: p.products,
  }));
  return c.json({ plans });
});

// ─── POST /plans/upgrade ───
app.post('/plans/upgrade', requireAuth, async (c) => {
  const body = await c.req.json<{ customer_id: string; plan: string }>();
  if (!body.customer_id) return c.json({ error: 'customer_id required' }, 400);
  const plan = SHOPIFY_PLANS[body.plan];
  if (!plan) return c.json({ error: 'Invalid plan. Valid: starter, business, enterprise' }, 400);
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 503);

  // Get current subscription
  const sub = await c.env.DB.prepare(
    'SELECT * FROM subscriptions WHERE stripe_customer_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(body.customer_id, 'active').first<{ stripe_subscription_id: string; plan: string }>();

  if (!sub) return c.json({ error: 'No active subscription found' }, 404);
  if (sub.plan === body.plan) return c.json({ error: 'Already on this plan' }, 400);

  // Retrieve subscription items from Stripe
  const stripeSub = await stripeAPI(c.env, 'GET', `/subscriptions/${sub.stripe_subscription_id}`) as {
    items: { data: Array<{ id: string }> };
  };
  const itemId = stripeSub.items?.data?.[0]?.id;
  if (!itemId) return c.json({ error: 'Could not retrieve subscription item' }, 500);

  // Update subscription with new price
  const updated = await stripeAPI(c.env, 'POST', `/subscriptions/${sub.stripe_subscription_id}`, {
    'items[0][id]': itemId,
    'items[0][price_data][currency]': 'usd',
    'items[0][price_data][unit_amount]': plan.price.toString(),
    'items[0][price_data][recurring][interval]': 'month',
    'items[0][price_data][product_data][name]': `Echo Shopify — ${plan.name}`,
    proration_behavior: 'create_prorations',
    'metadata[plan]': body.plan,
    'metadata[stores_limit]': String(plan.stores),
    'metadata[products_limit]': String(plan.products),
  }) as { id: string; status: string };

  // Update local DB
  await c.env.DB.prepare(
    `UPDATE subscriptions SET plan = ?, stores_limit = ?, products_limit = ?, updated_at = datetime('now') WHERE stripe_customer_id = ?`
  ).bind(body.plan, plan.stores === 'unlimited' ? -1 : plan.stores, plan.products === 'unlimited' ? -1 : plan.products, body.customer_id).run();

  log('info', 'billing', 'Plan upgraded', { customer: body.customer_id, from: sub.plan, to: body.plan });
  c.env.ANALYTICS.writeDataPoint({ blobs: ['plan_upgrade', body.plan], doubles: [plan.price] });

  return c.json({
    success: true,
    subscription_id: updated.id,
    new_plan: body.plan,
    new_price: `$${(plan.price / 100).toFixed(2)}/mo`,
    stores_limit: plan.stores,
    products_limit: plan.products,
  });
});

// ─── Billing: Create Checkout Session ───
app.post('/billing/checkout', requireAuth, async (c) => {
  const body = await c.req.json<{ plan: string; customer_email: string; success_url?: string; cancel_url?: string }>();
  const plan = SHOPIFY_PLANS[body.plan];
  if (!plan) return c.json({ error: 'Invalid plan. Valid: starter, business, enterprise' }, 400);
  if (!body.customer_email) return c.json({ error: 'customer_email required' }, 400);
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 503);

  const session = await stripeAPI(c.env, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': plan.price.toString(),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': `Echo Shopify — ${plan.name}`,
    'line_items[0][price_data][product_data][description]': `${plan.stores === 'unlimited' ? 'Unlimited' : plan.stores} store(s), ${plan.products === 'unlimited' ? 'Unlimited' : plan.products} products`,
    'line_items[0][quantity]': '1',
    customer_email: body.customer_email,
    success_url: body.success_url || 'https://echo-ept.com/shopify?billing=success',
    cancel_url: body.cancel_url || 'https://echo-ept.com/shopify?billing=cancelled',
    'metadata[plan]': body.plan,
    'metadata[worker]': 'echo-shopify',
    'metadata[stores_limit]': String(plan.stores),
    'metadata[products_limit]': String(plan.products),
  }) as { id: string; url: string };

  log('info', 'billing', 'Checkout session created', { plan: body.plan, email: body.customer_email });
  c.env.ANALYTICS.writeDataPoint({ blobs: ['checkout_created', body.plan], doubles: [plan.price] });
  return c.json({ session_id: session.id, checkout_url: session.url });
});

// ─── Billing: Customer Portal ───
app.post('/billing/portal', requireAuth, async (c) => {
  const body = await c.req.json<{ customer_id: string; return_url?: string }>();
  if (!body.customer_id) return c.json({ error: 'customer_id required' }, 400);
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 503);

  const portal = await stripeAPI(c.env, 'POST', '/billing_portal/sessions', {
    customer: body.customer_id,
    return_url: body.return_url || 'https://echo-ept.com/shopify',
  }) as { url: string };

  return c.json({ portal_url: portal.url });
});

// ─── Billing: Subscription Status ───
app.get('/billing/status/:customerId', requireAuth, async (c) => {
  const customerId = c.req.param('customerId');
  const sub = await c.env.DB.prepare(
    'SELECT * FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(customerId).first();

  if (!sub) return c.json({ subscribed: false, plan: null });

  return c.json({
    subscribed: (sub as any).status === 'active',
    plan: (sub as any).plan,
    status: (sub as any).status,
    stripe_subscription_id: (sub as any).stripe_subscription_id,
    stores_limit: (sub as any).stores_limit,
    products_limit: (sub as any).products_limit,
    current_period_end: (sub as any).current_period_end,
  });
});

// ─── Stripe Webhook (exempt from auth) ───
app.post('/webhooks/stripe', async (c) => {
  const payload = await c.req.text();
  const sigHeader = c.req.header('stripe-signature') || '';

  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    log('warn', 'stripe', 'STRIPE_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Webhook secret not configured' }, 503);
  }

  const valid = await verifyStripeSignature(payload, sigHeader, c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    log('warn', 'stripe', 'Invalid Stripe signature on webhook');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const event = JSON.parse(payload);
  log('info', 'stripe', 'Stripe webhook received', { type: event.type, id: event.id });
  c.env.ANALYTICS.writeDataPoint({ blobs: ['stripe_webhook', event.type], doubles: [1] });

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const plan = session.metadata?.plan || 'starter';
      const planData = SHOPIFY_PLANS[plan];
      await c.env.DB.prepare(
        `INSERT INTO subscriptions (stripe_customer_id, stripe_subscription_id, plan, status, stores_limit, products_limit, customer_email, current_period_end, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, datetime(?, 'unixepoch'), datetime('now'), datetime('now'))
         ON CONFLICT(stripe_customer_id) DO UPDATE SET
           stripe_subscription_id = excluded.stripe_subscription_id,
           plan = excluded.plan,
           status = 'active',
           stores_limit = excluded.stores_limit,
           products_limit = excluded.products_limit,
           current_period_end = excluded.current_period_end,
           updated_at = datetime('now')`
      ).bind(
        session.customer,
        session.subscription,
        plan,
        planData ? (planData.stores === 'unlimited' ? -1 : planData.stores) : 1,
        planData ? (planData.products === 'unlimited' ? -1 : planData.products) : 500,
        session.customer_details?.email || '',
        Math.floor(Date.now() / 1000) + 30 * 86400,
      ).run();
      log('info', 'stripe', 'Subscription created', { customer: session.customer, plan });
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      await c.env.DB.prepare(
        `UPDATE subscriptions SET status = ?, current_period_end = datetime(?, 'unixepoch'), updated_at = datetime('now')
         WHERE stripe_subscription_id = ?`
      ).bind(sub.status, sub.current_period_end, sub.id).run();
      log('info', 'stripe', 'Subscription updated', { sub_id: sub.id, status: sub.status });
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await c.env.DB.prepare(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = datetime('now')
         WHERE stripe_subscription_id = ?`
      ).bind(sub.id).run();
      log('info', 'stripe', 'Subscription cancelled', { sub_id: sub.id });
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      await c.env.DB.prepare(
        `INSERT INTO payment_history (stripe_customer_id, stripe_invoice_id, amount_cents, currency, status, plan, created_at)
         VALUES (?, ?, ?, ?, 'paid', ?, datetime('now'))`
      ).bind(invoice.customer, invoice.id, invoice.amount_paid, invoice.currency, invoice.lines?.data?.[0]?.metadata?.plan || 'unknown').run();
      log('info', 'stripe', 'Payment recorded', { customer: invoice.customer, amount: invoice.amount_paid });
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await c.env.DB.prepare(
        `UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now')
         WHERE stripe_customer_id = ?`
      ).bind(invoice.customer).run();
      log('warn', 'stripe', 'Payment failed', { customer: invoice.customer });
      break;
    }

    default:
      log('info', 'stripe', 'Unhandled Stripe event', { type: event.type });
  }

  return c.json({ received: true });
});

// ─── Admin: Billing Stats ───
app.get('/billing/stats', requireAuth, async (c) => {
  const [active, cancelled, revenue, pastDue] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'active'").first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'cancelled'").first<{ count: number }>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM payment_history WHERE status = 'paid'").first<{ total: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'past_due'").first<{ count: number }>(),
  ]);

  return c.json({
    active_subscriptions: active?.count || 0,
    cancelled_subscriptions: cancelled?.count || 0,
    past_due: pastDue?.count || 0,
    total_revenue_cents: revenue?.total || 0,
    total_revenue_display: `$${((revenue?.total || 0) / 100).toFixed(2)}`,
  });
});

// ─── Admin: Migrate Stripe Schema ───
app.post('/admin/migrate-stripe', requireAuth, async (c) => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_customer_id TEXT UNIQUE NOT NULL,
      stripe_subscription_id TEXT,
      plan TEXT NOT NULL DEFAULT 'starter',
      status TEXT NOT NULL DEFAULT 'active',
      stores_limit INTEGER DEFAULT 1,
      products_limit INTEGER DEFAULT 500,
      customer_email TEXT,
      current_period_end TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS payment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_customer_id TEXT NOT NULL,
      stripe_invoice_id TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      currency TEXT DEFAULT 'usd',
      status TEXT NOT NULL,
      plan TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sub_customer ON subscriptions(stripe_customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_pay_customer ON payment_history(stripe_customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pay_invoice ON payment_history(stripe_invoice_id)`,
  ];

  for (const stmt of statements) {
    await c.env.DB.prepare(stmt).run();
  }

  log('info', 'admin', 'Stripe billing schema migrated');
  return c.json({ success: true, message: 'Stripe billing tables created', tables: ['subscriptions', 'payment_history'] });
});

// ─── 404 ─────────────────────────────────────────────────────────────────────

app.notFound((c) => c.json({ error: 'Not found', worker: 'echo-shopify', docs: '/health' }, 404));

app.onError((err, c) => {
  log('error', 'global', 'Unhandled error', { error: err.message, stack: err.stack });
  return c.json({ error: 'Internal server error' }, 500);
});

// ─── EXPORT ──────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
};
