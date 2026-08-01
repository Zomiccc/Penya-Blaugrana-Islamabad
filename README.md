# Penya Blaugrana Islamabad — Website + Admin Panel

## What's inside
- `public/` — the website (Home, About, Join Us, Media, Statutes, Contact) plus `public/admin/` (admin dashboard)
- `server.js` — Node/Express server: serves the site, protects the admin panel, runs the membership/pricing API and Stripe integration
- `lib/db.js` — tiny JSON-file datastore (`data/db.json`) holding admin credentials, live pricing, and member submissions
- `data/db.json` — created automatically on first run (not committed — see below)

## Local setup
```
npm install
cp .env.example .env      # then fill in JWT_SECRET, Stripe keys, etc.
npm start
```
Site: http://localhost:3000
Admin: http://localhost:3000/admin/login.html — default login is `admin` / `changeme123`
**Change this password immediately** from the dashboard's "Change Admin Password" panel, or set `ADMIN_INITIAL_PASSWORD` in `.env` before the very first run (it only takes effect once, when `data/db.json` is first created).

## Stripe setup
1. Get your Stripe secret key (`sk_test_...` for testing, `sk_live_...` for real payments) and put it in `STRIPE_SECRET_KEY`.
2. Create a webhook in the Stripe dashboard pointing at `https://yourdomain.com/api/stripe/webhook`, listening for `checkout.session.completed`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Set `PUBLIC_BASE_URL` to your real domain so Stripe redirects back correctly after payment.
4. Confirm your Stripe account supports PKR — if not, you'll need to charge in USD/another supported currency or switch to a local gateway.

Until Stripe is configured, the Join Us form still saves every submission (visible in the admin Members table) but shows a message that online payment isn't set up yet — an admin can mark a submission "Paid" manually in the meantime.

## Admin panel features
- Change Adult/Kids membership price live — the Join Us page and Stripe checkout always use the current price
- View/search/filter member submissions, export to CSV, manually mark as paid, delete
- Change the admin password

## Data storage note
`data/db.json` is a flat file, fine for a small club's volume of signups. If this grows a lot, swap `lib/db.js` for a real database (Postgres/SQLite) — the rest of the app doesn't need to change since all reads/writes go through `readDb()`/`writeDb()`.

## Live match data
`public/script.js` pulls FC Barcelona's next fixture (opponent, kickoff time, **venue**) from TheSportsDB's free public API and drives the homepage countdown from it. The free tier only reliably returns one upcoming match — see comments in `script.js` for how to upgrade to a paid key/provider for a full fixture list.
