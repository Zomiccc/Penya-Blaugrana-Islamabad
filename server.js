require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { readDb, writeDb } = require('./lib/db');
const { sendJoinConfirmation, sendPaymentReceipt } = require('./lib/mailer');
const { buildFixturesRouter } = require('./src/routes/fixtures.route');
const { startFixtureSync } = require('./src/jobs/fixtureSync.job');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PAYMENT_LINK_ADULT = process.env.STRIPE_PAYMENT_LINK_ADULT || '';
const STRIPE_PAYMENT_LINK_KIDS = process.env.STRIPE_PAYMENT_LINK_KIDS || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set in .env — using a random secret for this process only. ' +
    'Admin sessions will be invalidated every time the server restarts. Set JWT_SECRET in .env for production.');
}
if (STRIPE_PAYMENT_LINK_ADULT || STRIPE_PAYMENT_LINK_KIDS) {
  console.log('[info] STRIPE_PAYMENT_LINK_* set — using simple redirect mode for payments.');
} else if (!stripe) {
  console.warn('[warn] STRIPE_SECRET_KEY not set — the Join Us payment flow will save submissions but ' +
    'cannot create real checkout sessions until you add a Stripe key to .env');
}

// ---------- Stripe webhook needs the RAW body, so register it before express.json() ----------
// Note: When using STRIPE_PAYMENT_LINK_* mode, webhooks are not used. The payment link
// handles payment confirmation directly through Stripe's hosted checkout page.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (STRIPE_PAYMENT_LINK_ADULT || STRIPE_PAYMENT_LINK_KIDS) {
    console.warn('[webhook] Payment link mode is active — webhooks are not used in this mode.');
    return res.status(200).send('ignored (payment link mode)');
  }
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.warn('[webhook] Received event but Stripe/webhook secret not configured — ignoring.');
    return res.status(200).send('ignored (not configured)');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const memberId = session.client_reference_id;
    writeDb((db) => {
      const member = db.members.find((m) => m.id === memberId);
      if (member) {
        member.status = 'paid';
        member.stripeSessionId = session.id;
        member.paidAt = new Date().toISOString();
      } else {
        console.warn('[webhook] checkout.session.completed for unknown member id:', memberId);
      }
      return db;
    })
      .then((updated) => {
        const member = updated.members.find((m) => m.id === memberId);
        if (member) {
          // Payment receipt — best-effort, non-blocking.
          sendPaymentReceipt(member).catch((err) => {
            console.error('[mailer] failed to send payment receipt:', err.message);
          });
        }
      })
      .catch((err) => console.error('[webhook] failed to update member:', err));
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(cookieParser());

// ---------------------------- Auth helpers ----------------------------
function signSession(username) {
  return jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
}
function requireAdmin(req, res, next) {
  const token = req.cookies.pbi_admin_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('pbi_admin_session');
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}
function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 8 * 60 * 60 * 1000 };
}

// ---------------------------- Fixtures (Football-Data.org, cached) ----------------------------
// Public + admin fixture endpoints. The scheduler keeps data/fixtures.json
// fresh (12h normally, 5 min on match day) — visitors never hit Football-Data.
app.use(buildFixturesRouter(requireAdmin));

// ---------------------------- Admin auth API ----------------------------
const loginAttempts = new Map(); // ip -> {count, resetAt}  (basic brute-force throttle)
app.post('/api/admin/login', async (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.count >= 8 && now < attempt.resetAt) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const db = readDb();
  const ok = username === db.admin.username && (await bcrypt.compare(password, db.admin.passwordHash));

  if (!ok) {
    const next = { count: (attempt?.count || 0) + 1, resetAt: now + 5 * 60 * 1000 };
    loginAttempts.set(ip, next);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  loginAttempts.delete(ip);

  res.cookie('pbi_admin_session', signSession(username), cookieOptions());
  res.json({ ok: true, username });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('pbi_admin_session');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const db = readDb();
  const ok = await bcrypt.compare(currentPassword || '', db.admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(newPassword, 10);
  await writeDb((d) => { d.admin.passwordHash = newHash; return d; });
  res.json({ ok: true });
});

// ---------------------------- Media gallery (self-hosted, admin-managed) ----------------------------
// No third-party widget/API. The admin adds a photo or video URL (plus an
// optional caption and an optional link) from the dashboard; the Media page
// fetches this list and renders it directly. Tapping a photo opens its link
// (or the club's Instagram profile if no link was set); videos play inline.
const INSTAGRAM_PROFILE_URL = 'https://www.instagram.com/pbislamabad';
const VALID_MEDIA_TYPES = ['photo', 'video'];

app.get('/api/media', (req, res) => {
  const db = readDb();
  // Posts are stored in display order (index 0 = first shown). Expose `order`
  // so the admin UI can show/disable the up/down buttons correctly.
  const posts = (db.mediaPosts || []).map((p, i) => ({ ...p, order: i }));
  res.json({ posts });
});

app.post('/api/admin/media', requireAdmin, async (req, res) => {
  const { type, src, caption, link } = req.body || {};
  if (!VALID_MEDIA_TYPES.includes(type)) return res.status(400).json({ error: 'type must be "photo" or "video"' });
  if (!src || !String(src).trim()) return res.status(400).json({ error: 'A media URL is required' });
  if (caption && String(caption).length > 500) return res.status(400).json({ error: 'Caption is too long (max 500 characters)' });
  if (link && String(link).length > 500) return res.status(400).json({ error: 'Link is too long' });

  const post = {
    id: crypto.randomUUID(),
    type,
    src: String(src).trim(),
    caption: caption ? String(caption).trim() : '',
    link: link && String(link).trim() ? String(link).trim() : INSTAGRAM_PROFILE_URL,
    createdAt: new Date().toISOString(),
  };
  const updated = await writeDb((db) => {
    db.mediaPosts = db.mediaPosts || [];
    db.mediaPosts.push(post);
    return db;
  });
  res.json({ ok: true, post, posts: updated.mediaPosts });
});

app.delete('/api/admin/media/:id', requireAdmin, async (req, res) => {
  const updated = await writeDb((db) => {
    db.mediaPosts = (db.mediaPosts || []).filter((p) => p.id !== req.params.id);
    return db;
  });
  res.json({ ok: true, posts: updated.mediaPosts });
});

// Reorder a post up (dir: -1) or down (dir: +1) within the gallery.
app.post('/api/admin/media/:id/move', requireAdmin, async (req, res) => {
  const dir = Number(req.body && req.body.dir);
  if (dir !== -1 && dir !== 1) return res.status(400).json({ error: 'dir must be -1 or 1' });
  const updated = await writeDb((db) => {
    const posts = db.mediaPosts || [];
    const i = posts.findIndex((p) => p.id === req.params.id);
    if (i === -1) return db;
    const j = i + dir;
    if (j < 0 || j >= posts.length) return db;
    [posts[i], posts[j]] = [posts[j], posts[i]];
    return db;
  });
  res.json({ ok: true, posts: updated.mediaPosts });
});

// ---------------------------- Instagram feed (Legacy SnapWidget embed - DEPRECATED) ----------------------------
// NOTE: The Media page now uses the self-hosted media gallery above instead of
// any third-party widget. These endpoints are kept only for backward compatibility.
app.get('/api/instagram-embed', (req, res) => {
  const db = readDb();
  res.json({ embedCode: db.instagramEmbedCode || '' });
});

app.put('/api/admin/instagram-embed', requireAdmin, async (req, res) => {
  const { embedCode } = req.body || {};
  if (typeof embedCode !== 'string') return res.status(400).json({ error: 'embedCode must be a string' });
  if (embedCode.length > 5000) return res.status(400).json({ error: 'Embed code is unexpectedly long — please double check what you pasted.' });
  const updated = await writeDb((db) => { db.instagramEmbedCode = embedCode.trim(); return db; });
  res.json({ embedCode: updated.instagramEmbedCode });
});

// ---------------------------- Pricing ----------------------------
// Public: anyone (the Join Us page) can read current prices.
app.get('/api/pricing', (req, res) => {
  const db = readDb();
  res.json(db.pricing);
});

// Admin-only: change prices. This is what makes the Stripe checkout amount
// "live" — join.html always asks the server for the current price at the
// moment someone submits the form, it never hardcodes an amount.
app.put('/api/admin/pricing', requireAdmin, async (req, res) => {
  const { adult, kids, currency } = req.body || {};
  if (adult == null || kids == null) return res.status(400).json({ error: 'adult and kids prices are required' });
  const adultNum = Number(adult);
  const kidsNum = Number(kids);
  if (!Number.isFinite(adultNum) || adultNum <= 0 || !Number.isFinite(kidsNum) || kidsNum <= 0) {
    return res.status(400).json({ error: 'Prices must be positive numbers' });
  }
  const updated = await writeDb((db) => {
    db.pricing = { adult: adultNum, kids: kidsNum, currency: currency || db.pricing.currency || 'PKR' };
    return db;
  });
  res.json(updated.pricing);
});

// ---------------------------- Membership submission + Stripe Checkout ----------------------------
const VALID_TYPES = ['adult', 'kids'];

app.post('/api/join', async (req, res) => {
  const b = req.body || {};
  const required = ['firstName', 'lastName', 'contactNumber', 'country', 'email', 'membershipType'];
  for (const field of required) {
    if (!b[field] || String(b[field]).trim() === '') {
      return res.status(400).json({ error: `Missing required field: ${field}` });
    }
  }
  if (!VALID_TYPES.includes(b.membershipType)) {
    return res.status(400).json({ error: 'membershipType must be "adult" or "kids"' });
  }
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email);
  if (!emailOk) return res.status(400).json({ error: 'Please provide a valid email address' });
  if (b.membershipType === 'kids' && (!b.childName || !b.childDob)) {
    return res.status(400).json({ error: 'Child full name and date of birth are required for a kids membership' });
  }
  if (!b.agreedToStatutes) {
    return res.status(400).json({ error: 'You must agree to the Statutes and Privacy Notice' });
  }

  const db = readDb();
  const price = db.pricing[b.membershipType];
  const memberId = crypto.randomUUID();

  const member = {
    id: memberId,
    firstName: b.firstName.trim(),
    lastName: b.lastName.trim(),
    contactNumber: b.contactNumber.trim(),
    country: b.country.trim(),
    email: b.email.trim(),
    membershipType: b.membershipType,
    childName: b.membershipType === 'kids' ? b.childName.trim() : null,
    childDob: b.membershipType === 'kids' ? b.childDob : null,
    amount: price,
    currency: db.pricing.currency,
    status: 'pending',
    stripeSessionId: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };

  await writeDb((d) => { d.members.push(member); return d; });

  // Send the applicant a confirmation email (best-effort; never block the
  // response on mail delivery. If SendGrid is misconfigured or the sender
  // isn't verified yet, the join still succeeds.)
  sendJoinConfirmation(member).catch((err) => {
    console.error('[mailer] failed to send join confirmation:', err.message);
  });

  // Payment Link mode (simple redirect) - takes priority over full Stripe integration
  if (STRIPE_PAYMENT_LINK_ADULT || STRIPE_PAYMENT_LINK_KIDS) {
    const paymentLink = b.membershipType === 'adult' ? STRIPE_PAYMENT_LINK_ADULT : STRIPE_PAYMENT_LINK_KIDS;
    if (paymentLink) {
      return res.json({ ok: true, memberId, checkoutUrl: paymentLink });
    }
    // If the specific membership type link is not set, fall through to warning
    console.warn(`[stripe] Payment link not configured for membership type: ${b.membershipType}`);
  }

  // Full Stripe Checkout session mode (legacy - can be re-enabled by removing STRIPE_PAYMENT_LINK_*)
  if (!stripe) {
    return res.status(200).json({
      ok: true,
      memberId,
      warning: 'Submission saved, but online payment is not configured yet on this server ' +
        '(missing STRIPE_SECRET_KEY or STRIPE_PAYMENT_LINK_*). An admin needs to add it, or mark this member as paid manually.',
      checkoutUrl: null,
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: memberId,
      customer_email: member.email,
      line_items: [
        {
          price_data: {
            currency: (db.pricing.currency || 'PKR').toLowerCase(),
            product_data: {
              name: `Penya Blaugrana Islamabad — ${b.membershipType === 'adult' ? 'Adult' : 'Kids (Under 16)'} Membership`,
            },
            unit_amount: Math.round(price * 100), // Stripe expects the smallest currency unit
          },
          quantity: 1,
        },
      ],
      metadata: { memberId, membershipType: b.membershipType },
      success_url: `${PUBLIC_BASE_URL}/join-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/join.html?canceled=1`,
    });

    await writeDb((d) => {
      const m = d.members.find((x) => x.id === memberId);
      if (m) m.stripeSessionId = session.id;
      return d;
    });

    res.json({ ok: true, memberId, checkoutUrl: session.url });
  } catch (err) {
    console.error('[stripe] failed to create checkout session:', err.message);
    res.status(502).json({
      ok: true,
      memberId,
      warning: 'Submission saved, but we could not start the Stripe checkout (' + err.message + '). ' +
        'Please contact the club or try again shortly.',
      checkoutUrl: null,
    });
  }
});

// Confirms a session client-side on the success page (belt-and-braces on top of the webhook,
// since webhooks can be delayed by a few seconds).
app.get('/api/checkout-session/:id', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({ status: session.payment_status, memberId: session.client_reference_id });
  } catch (err) {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ---------------------------- Admin: members ----------------------------
app.get('/api/admin/members', requireAdmin, (req, res) => {
  const db = readDb();
  const { status, type, q } = req.query;
  let members = [...db.members].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (status) members = members.filter((m) => m.status === status);
  if (type) members = members.filter((m) => m.membershipType === type);
  if (q) {
    const needle = String(q).toLowerCase();
    members = members.filter((m) =>
      `${m.firstName} ${m.lastName} ${m.email} ${m.country}`.toLowerCase().includes(needle));
  }
  res.json({ members, total: db.members.length });
});

app.post('/api/admin/members/:id/mark-paid', requireAdmin, async (req, res) => {
  const updated = await writeDb((db) => {
    const m = db.members.find((x) => x.id === req.params.id);
    if (m) { m.status = 'paid'; m.paidAt = new Date().toISOString(); m.manualOverride = true; }
    return db;
  });
  const member = updated.members.find((x) => x.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Member not found' });

  console.log('[mailer] Sending payment receipt to:', member.email, 'for member:', member.firstName, member.lastName);

  // Send the receipt when an admin manually marks a member as paid too
  // (best-effort, non-blocking).
  sendPaymentReceipt(member).catch((err) => {
    console.error('[mailer] failed to send payment receipt (manual):', err.message);
  });

  res.json({ ok: true, member });
});

app.delete('/api/admin/members/:id', requireAdmin, async (req, res) => {
  await writeDb((db) => {
    db.members = db.members.filter((x) => x.id !== req.params.id);
    return db;
  });
  res.json({ ok: true });
});

app.get('/api/admin/members/export.csv', requireAdmin, (req, res) => {
  const db = readDb();
  const cols = ['id', 'firstName', 'lastName', 'email', 'contactNumber', 'country',
    'membershipType', 'childName', 'childDob', 'amount', 'currency', 'status', 'createdAt', 'paidAt'];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [cols.join(',')].concat(
    db.members.map((m) => cols.map((c) => escape(m[c])).join(','))
  );
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="pbi-members.csv"');
  res.send(rows.join('\n'));
});

app.get('/api/admin/dashboard-stats', requireAdmin, (req, res) => {
  const db = readDb();
  const total = db.members.length;
  const paid = db.members.filter((m) => m.status === 'paid').length;
  const pending = total - paid;
  const adults = db.members.filter((m) => m.membershipType === 'adult').length;
  const kids = db.members.filter((m) => m.membershipType === 'kids').length;
  const revenue = db.members.filter((m) => m.status === 'paid').reduce((sum, m) => sum + (m.amount || 0), 0);
  res.json({ total, paid, pending, adults, kids, revenue, currency: db.pricing.currency });
});

// ---------------------------- Static hosting ----------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');

// Admin dashboard HTML pages are gated server-side: login.html is always
// public, everything else under /admin/ requires a valid session cookie.
app.get('/admin/:page', (req, res, next) => {
  if (req.params.page === 'login.html' || req.params.page === 'login') return next();
  const token = req.cookies.pbi_admin_session;
  if (!token) return res.redirect('/admin/login.html');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('pbi_admin_session');
    return res.redirect('/admin/login.html');
  }
});

app.use(express.static(PUBLIC_DIR));

app.get('/admin', (req, res) => res.redirect('/admin/dashboard.html'));

app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'), (err) => {
  if (err) res.status(404).send('Not found');
}));

app.listen(PORT, () => {
  console.log(`Penya Blaugrana Islamabad server running on http://localhost:${PORT}`);
  // Start the fixture sync scheduler (fires an immediate sync at boot).
  startFixtureSync();
});
