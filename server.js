// Basketball Money — payment server.
//
// Deployed as a Render "Web Service" (not a static site). The Stripe
// secret key lives here in Render's environment variables, never in
// the browser.
//
// Two jobs:
//
// 1. POST /create-checkout-session — the Buy button calls this. It
//    looks up the real price from card_designs (never trusts a price
//    sent by the browser), then asks Stripe to open a hosted Checkout
//    page and returns that page's URL.
//
// 2. POST /webhook — Stripe calls this server-to-server only when a
//    payment genuinely succeeded. The card and its tabs are created
//    HERE, never by the browser. That's what stops anyone minting
//    free cards by calling the API directly. The 50/50 split is also
//    calculated and frozen here.

const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = express();

// Where card links point. Set CARD_BASE_URL in Render to your public
// site (e.g. https://cashflowhoops.com). No trailing slash.
const CARD_BASE_URL = (process.env.CARD_BASE_URL || 'https://cashflowhoops.com').replace(/\/$/, '');
const MAIL_FROM = process.env.MAIL_FROM || 'Basketball Money <onboarding@resend.dev>';
// Card emails come from a send-only address. Replies need somewhere
// real to land, so point them at an inbox that is actually read.
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Stripe's webhook needs the raw, unparsed body to verify its
// signature, so this route is declared BEFORE express.json() and
// handles its own raw body. Moving this below express.json() breaks
// signature verification with a confusing error.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).send('ok');
  }

  const session = event.data.object;
  const designId = session.metadata?.design_id;
  const campaignId = session.metadata?.campaign_id;
  const playerId = session.metadata?.player_id || null;
  const buyerName = session.metadata?.buyer_name || 'Supporter';
  const buyerEmail = session.customer_details?.email || null;

  if (!designId || !campaignId) {
    console.error('Webhook fired without design_id or campaign_id in metadata');
    return res.status(400).send('Missing metadata');
  }

  try {
    // Re-read the design so the money is calculated from the database,
    // not from anything that travelled through the browser.
    const { data: design, error: designErr } = await supabase
      .from('card_designs')
      .select('id, tab_count, price, team_share_pct, offer_text, valid_when, expires_on, kind, license_product, redeem_url, merchants(name)')
      .eq('id', designId)
      .single();

    if (designErr || !design) throw designErr || new Error('Design not found');

    design.merchant_name = design.merchants?.name || 'Basketball Money';

    // player name, for the email copy only
    design.player_name = null;
    if (playerId) {
      const { data: p } = await supabase.from('players').select('name').eq('id', playerId).single();
      if (p) design.player_name = p.name;
    }

    // How many cards were bought. Read from the line item so it is
    // Stripe's own record, not anything the browser claimed.
    let quantity = 1;
    try {
      const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
      quantity = items.data[0]?.quantity || 1;
    } catch (e) {
      console.error('Could not read quantity, defaulting to 1:', e.message);
    }

    // amount_total covers every card, so divide to get the per-card
    // price before splitting it.
    const totalPaid = Number(session.amount_total) / 100;
    const pricePaid = +(totalPaid / quantity).toFixed(2);
    const teamAmount = +(pricePaid * (design.team_share_pct / 100)).toFixed(2);
    const platformAmount = +(pricePaid - teamAmount).toFixed(2);

    // One row per card, each with its own token. card_index makes the
    // rows distinct within the session, so a repeated webhook delivery
    // still collides on the unique constraint instead of duplicating.
    // A card lasts a year from purchase, unless the merchant set an
    // earlier end date on the design — then whichever comes first.
    const oneYear = new Date();
    oneYear.setFullYear(oneYear.getFullYear() + 1);
    let expiresOn = oneYear.toISOString().slice(0, 10);
    if (design.expires_on && design.expires_on < expiresOn) {
      expiresOn = design.expires_on;
    }

    const cardRows = Array.from({ length: quantity }, (_, i) => ({
      design_id: design.id,
      expires_on: expiresOn,
      campaign_id: campaignId,
      player_id: playerId || null,
      card_token: randToken(),
      card_index: i + 1,
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      price_paid: pricePaid,
      team_amount: teamAmount,
      platform_amount: platformAmount,
      payment_status: 'paid',
      stripe_session_id: session.id,
    }));

    const { data: cards, error: cardErr } = await supabase
      .from('cards')
      .insert(cardRows)
      .select();

    if (cardErr) {
      // 23505 = unique violation. Stripe delivers the same event more
      // than once by design. This session's cards already exist, so
      // this is not a failure — acknowledge and stop.
      if (cardErr.code === '23505') {
        console.log(`Session ${session.id} already processed, skipping`);
        return res.status(200).send('ok (already processed)');
      }
      throw cardErr;
    }

    if (design.kind === 'license') {
      // A license has no coupons. Each purchased card becomes a row in
      // the shared licenses table, so the product's own gate accepts it
      // with no integration between the two systems.
      const licenseRows = cards.map(c => ({
        code: c.card_token,
        product: design.license_product,
        school_name: buyerName || 'Supporter',
        expires_at: c.expires_on,
        active: true,
        // Sold licenses are device-capped; codes created by hand in
        // the license admin stay unlimited, since those are used for
        // recruiting schools and running free trials.
        max_devices: 5,
        notes: 'Purchased through Basketball Money'
      }));

      const { error: licErr } = await supabase.from('licenses').insert(licenseRows);
      if (licErr) throw licErr;
    } else {
      // Every tab for every card, inserted in one request rather than
      // one per tab. A 32-tab card at quantity 5 is 160 rows.
      const tabRows = [];
      for (const c of cards) {
        for (let i = 0; i < design.tab_count; i++) {
          tabRows.push({ card_id: c.id, tab_number: i + 1, status: 'sealed' });
        }
      }

      const { error: tabsErr } = await supabase.from('card_tabs').insert(tabRows);
      if (tabsErr) throw tabsErr;
    }

    const card = cards[0];

    console.log(`${cards.length} card(s) created — ${cards.map(c => c.card_token).join(', ')} — ${design.tab_count} tabs each, $${(teamAmount * cards.length).toFixed(2)} to team, payment ${session.id}`);

    // Email the buyer their card link. Deliberately after the card
    // exists and wrapped in its own try/catch: a mail outage must
    // never make this webhook fail and trigger a Stripe retry on a
    // card that was already created.
    if (buyerEmail) {
      try {
        await sendCardEmail({
          to: buyerEmail,
          buyerName,
          tokens: cards.map(c => c.card_token),
          merchantName: design.merchant_name,
          offerText: design.offer_text,
          validWhen: design.valid_when,
          tabCount: design.tab_count,
          playerName: design.player_name,
          expiresOn,
          kind: design.kind,
          redeemUrl: design.redeem_url,
        });
        console.log(`Card link emailed to ${buyerEmail}`);
      } catch (mailErr) {
        console.error('Card created but email failed:', mailErr.message);
      }
    } else {
      console.log('No buyer email on session — card link not emailed');
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('Could not create card after payment:', e);
    // A non-200 makes Stripe retry automatically. Worth doing: real
    // money already moved, so the card genuinely needs to exist.
    res.status(500).send('Failed to create card');
  }
});

// Every other route gets normal JSON body parsing.
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { design_id, campaign_id, player_id, buyer_name, quantity, success_url, cancel_url } = req.body;
    if (!design_id) return res.status(400).json({ error: 'design_id is required' });
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });

    // Clamp to something sane. The real quantity is read back from
    // Stripe in the webhook, so this is only the starting value.
    const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 20);

    // Price comes from the database, never from the browser.
    const { data: design, error: designErr } = await supabase
      .from('card_designs')
      .select('id, name, tab_count, price, offer_text, active, merchants(name)')
      .eq('id', design_id)
      .single();

    if (designErr || !design) return res.status(404).json({ error: 'Card design not found' });
    if (design.active === false) return res.status(400).json({ error: 'This card is no longer available' });

    const { data: campaign, error: campaignErr } = await supabase
      .from('campaigns')
      .select('id, name')
      .eq('id', campaign_id)
      .single();

    if (campaignErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    const merchantName = design.merchants?.name || 'Basketball Money';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${merchantName} — ${design.tab_count}-tab BOGO card`,
            description: `${design.offer_text} · Supporting ${campaign.name}`,
          },
          unit_amount: Math.round(Number(design.price) * 100),
        },
        quantity: qty,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: 20 },
      }],
      metadata: {
        design_id: String(design_id),
        campaign_id: String(campaign_id),
        player_id: player_id ? String(player_id) : '',
        buyer_name: buyer_name || 'Supporter',
      },
      success_url: success_url || `${req.headers.origin}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || `${req.headers.origin}/?purchase=cancelled`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/', (req, res) => res.send('Basketball Money payment server is running.'));

// Sends the card link by email through Resend's HTTP API. No extra
// npm package needed — Node 18+ has fetch built in.
async function sendCardEmail({ to, buyerName, tokens, merchantName, offerText, validWhen, tabCount, playerName, expiresOn, kind, redeemUrl }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const list = Array.isArray(tokens) ? tokens : [tokens];
  const many = list.length > 1;
  const linkFor = (tk) => `${CARD_BASE_URL}/?card=${tk}`;
  const supporting = playerName ? ` supporting ${playerName}` : '';

  const isLicense = kind === 'license';

  const cardBlocks = isLicense ? list.map((tk, i) => `
    <div style="border:1px solid #e3e3e3;border-radius:12px;padding:18px;margin-bottom:14px;">
      ${many ? `<p style="margin:0 0 8px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px;">Access ${i + 1} of ${list.length}</p>` : ''}
      <p style="margin:0 0 4px;font-size:13px;color:#666;">One year of access</p>
      <p style="margin:0;font-size:13px;color:#666;">Your access code</p>
      <p style="margin:2px 0 14px;font-family:monospace;font-size:22px;font-weight:700;letter-spacing:2px;">${tk}</p>
      ${redeemUrl ? `<a href="${redeemUrl}" style="display:inline-block;background:#5b2377;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:700;font-size:14px;">Open ${merchantName}</a>
      <p style="margin:12px 0 0;font-size:11px;word-break:break-all;color:#5b2377;">${redeemUrl}</p>` : ''}
    </div>`).join('') : list.map((tk, i) => `
    <div style="border:1px solid #e3e3e3;border-radius:12px;padding:18px;margin-bottom:14px;">
      ${many ? `<p style="margin:0 0 8px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px;">Card ${i + 1} of ${list.length}</p>` : ''}
      <p style="margin:0 0 4px;font-size:13px;color:#666;">${tabCount} coupon tabs</p>
      <p style="margin:0 0 4px;font-size:17px;font-weight:700;">${offerText}</p>
      ${validWhen ? `<p style="margin:0 0 12px;font-size:13px;color:#8a5a00;font-weight:600;">${validWhen}</p>` : '<div style="height:8px"></div>'}
      <p style="margin:0;font-size:13px;color:#666;">Card code</p>
      <p style="margin:2px 0 14px;font-family:monospace;font-size:20px;font-weight:700;letter-spacing:1px;">${tk}</p>
      <a href="${linkFor(tk)}" style="display:inline-block;background:#5b2377;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:700;font-size:14px;">Open this card</a>
      <p style="margin:12px 0 0;font-size:11px;word-break:break-all;color:#5b2377;">${linkFor(tk)}</p>
    </div>`).join('');

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;">
    <h1 style="font-size:22px;margin:0 0 6px;">${many ? `Your ${list.length} ${merchantName} cards are ready` : `Your ${merchantName} card is ready`}</h1>
    <p style="margin:0 0 18px;color:#666;font-size:14px;">Thanks${buyerName ? ', ' + buyerName : ''} — your purchase${supporting} is confirmed.</p>

    ${cardBlocks}

    <p style="margin:22px 0 0;font-size:12px;color:#888;line-height:1.5;">
      ${expiresOn ? `Valid through ${expiresOn}. ` : ''}${isLicense
        ? `Save this email — ${many ? 'these codes are' : 'this code is'} how you get in.${many ? ' Each code is separate, so you can pass one on.' : ''}`
        : `Save this email — ${many ? 'these links are' : 'this link is'} how you open your ${many ? 'cards' : 'card'}.${many ? ' Each card is separate, so you can forward a link to whoever you are giving it to.' : ''}
      At the register, tap a coupon to peel it, then hand your phone to the cashier.`}
    </p>
  </div>`;

  const text = `${many ? `Your ${list.length} ${merchantName} cards are ready.` : `Your ${merchantName} card is ready.`}

${list.map((tk, i) => `${many ? `Card ${i + 1} of ${list.length}\n` : ''}Code: ${tk}
${tabCount} coupon tabs — ${offerText}${validWhen ? ' (' + validWhen + ')' : ''}
Open: ${linkFor(tk)}`).join('\n\n')}

${expiresOn ? `Valid through ${expiresOn}.\n` : ''}Save this email.${many ? ' Each card is separate — forward a link to whoever you are giving it to.' : ''} At the register, tap a coupon to peel it, then hand your phone to the cashier.`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
      to: [to],
      subject: many
        ? `Your ${list.length} ${merchantName} BOGO cards are ready`
        : `Your ${merchantName} BOGO card — code ${list[0]}`,
      html,
      text,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

function randToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Payment server listening on ${port}`));
