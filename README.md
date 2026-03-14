# echo-shopify

Cloudflare Worker providing Shopify e-commerce integration for [Echo Prime Technologies](https://echo-ept.com). Handles product catalog, cart/checkout via Shopify Storefront API, order management via Admin API, and webhook processing.

## Architecture

```
echo-ept.com (frontend)
      │
      ▼
echo-shopify (Cloudflare Worker)
  ├── /api/catalog        → EPT-API service binding (fallback) or Shopify Storefront API
  ├── /api/cart/*          → Shopify Storefront API (GraphQL)
  ├── /api/checkout        → Shopify Storefront API checkout creation
  ├── /webhook/shopify     → HMAC-SHA256 verified webhook processing
  ├── /api/admin/*         → Shopify Admin API (orders, fulfillment, config)
  └── Crons               → Catalog sync (6h), Daily report (2pm UTC)
      │
      ├── D1: echo-shopify (orders, webhook_events, products, analytics)
      ├── KV: CACHE (product cache, session state, 6h TTL)
      ├── Service Bindings:
      │   ├── EPT_API → ept-api (product catalog fallback)
      │   ├── ECHO_CHAT → echo-chat (AI product recommendations)
      │   └── SHARED_BRAIN → echo-shared-brain (order event memory)
      └── Shopify APIs (when configured):
          ├── Storefront API (products, cart, checkout)
          └── Admin API (orders, fulfillment, webhooks)
```

## Endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check with feature list |
| GET | `/api/catalog` | Full product catalog (Shopify or EPT-API fallback) |
| GET | `/api/catalog/:handle` | Single product by handle with checkout URL |
| GET | `/stats` | Order, webhook, and revenue statistics |

### Authenticated (X-Echo-API-Key)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/config` | Configuration status and setup steps |
| GET | `/api/admin/orders` | List orders with filters |
| GET | `/api/admin/orders/:id` | Single order details |
| POST | `/api/admin/register-webhooks` | Register 5 Shopify webhook topics |
| POST | `/api/admin/fulfill/:orderId` | Auto-fulfill digital product orders |
| POST | `/api/admin/sync-products` | Sync Shopify products to D1 + KV cache |

### Cart (requires Shopify Storefront token)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/cart/create` | Create new cart |
| POST | `/api/cart/:cartId/add` | Add line items to cart |
| GET | `/api/cart/:cartId` | Get cart contents |
| POST | `/api/checkout` | Create checkout URL from cart |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/shopify` | Shopify webhook receiver (HMAC-SHA256 verified) |

## Setup

### Prerequisites

- Cloudflare account with Workers enabled
- Node.js 18+
- wrangler CLI authenticated

### Install & Deploy

```bash
cd WORKERS/echo-shopify
npm install
npx wrangler deploy
```

### Configure Shopify (when ready)

1. Create a Shopify store at [shopify.com](https://shopify.com) (free dev store or trial)
2. Go to **Settings → Apps → Develop Apps → Create App**
3. Name: `Echo Prime Storefront`
4. Configure **Admin API scopes**: `read_orders`, `write_orders`, `read_products`, `write_products`, `read_fulfillments`, `write_fulfillments`
5. Configure **Storefront API scopes**: all product, cart, and checkout scopes
6. Install the app, reveal tokens
7. Set secrets:

```bash
echo "your-store.myshopify.com" | npx wrangler secret put SHOPIFY_STORE_DOMAIN
echo "shpat_xxxx" | npx wrangler secret put SHOPIFY_ADMIN_TOKEN
echo "xxxx" | npx wrangler secret put SHOPIFY_STOREFRONT_TOKEN
echo "whsec_xxxx" | npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
```

8. Register webhooks:

```bash
curl -X POST https://echo-shopify.bmcii1976.workers.dev/api/admin/register-webhooks \
  -H "X-Echo-API-Key: YOUR_KEY"
```

### Without Shopify

The worker operates in **fallback mode** without Shopify credentials — serving the full 17-product EPT catalog via the `ept-api` service binding. Cart and checkout features require Shopify.

## Storage

- **D1** (`echo-shopify`): Orders, webhook events, synced products, daily analytics
- **KV** (`CACHE`): Product cache (6h TTL), cart sessions, rate limit counters

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono v4
- **Language**: TypeScript
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **APIs**: Shopify Storefront API (GraphQL), Shopify Admin API (GraphQL)

## License

Proprietary — Echo Prime Technologies
