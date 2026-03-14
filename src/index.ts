/**
 * ECHO SHOPIFY INTEGRATION WORKER v1.0.0
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
}

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use('*', cors({
  origin: ['https://echo-ept.com', 'https://echo-prime-tech.vercel.app', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Echo-API-Key', 'X-Shopify-Hmac-Sha256'],
}));

// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(level: string, component: string, message: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, component, message, worker: 'echo-shopify', ...extra }));
}

// ─── HEALTH ──────────────────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '1.0.0',
    worker: 'echo-shopify',
    timestamp: new Date().toISOString(),
    shopify_store: c.env.SHOPIFY_STORE_DOMAIN || c.env.STORE_DOMAIN || 'not-configured',
    features: ['storefront-api', 'admin-api', 'webhooks', 'product-sync', 'auto-fulfillment', 'analytics'],
  });
});

// ─── SHOPIFY STOREFRONT API PROXY ────────────────────────────────────────────

const STOREFRONT_API_VERSION = '2024-10';

async function storefrontQuery(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const domain = env.SHOPIFY_STORE_DOMAIN || env.STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_TOKEN;
  if (!domain || !token) {
    throw new Error('Shopify Storefront API not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_TOKEN secrets.');
  }
  const url = `https://${domain}.myshopify.com/api/${STOREFRONT_API_VERSION}/graphql.json`;
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
    const { lines } = await c.req.json<{ lines: Array<{ variantId: string; quantity: number }> }>();
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
    const input = { lines: lines.map(l => ({ merchandiseId: l.variantId, quantity: l.quantity })) };
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
  const domain = env.SHOPIFY_STORE_DOMAIN || env.STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error('Shopify Admin API not configured');
  }
  const url = `https://${domain}.myshopify.com/admin/api/${ADMIN_API_VERSION}/graphql.json`;
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
    // Try Shopify first if configured
    if (c.env.SHOPIFY_STOREFRONT_TOKEN) {
      const cached = await c.env.CACHE.get('products:all', 'json');
      if (cached) return c.json({ source: 'shopify', ...(cached as object) });
    }

    // Serve from KV cache (populated by cron every 6h, or on first request via external fetch)
    const cached = await c.env.CACHE.get('catalog:ept', 'json');
    if (cached) return c.json(cached);

    // Cache miss — fetch via service binding
    const catalog = await fetchEptCatalog(c.env);
    if (catalog) {
      await c.env.CACHE.put('catalog:ept', JSON.stringify(catalog), { expirationTtl: 21600 }); // 6h
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
      version: '1.1.0',
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
          webhookSubscription { id topic { name } endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
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
