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
      .select('id, tab_count, price, team_share_pct')
      .eq('id', designId)
      .single();

    if (designErr || !design) throw designErr || new Error('Design not found');

    const pricePaid = Number(session.amount_total) / 100;
    const teamAmount = +(pricePaid * (design.team_share_pct / 100)).toFixed(2);
    const platformAmount = +(pricePaid - teamAmount).toFixed(2);

    const { data: card, error: cardErr } = await supabase
      .from('cards')
      .insert({
        design_id: design.id,
        campaign_id: campaignId,
        player_id: playerId || null,
        card_token: randToken(),
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        price_paid: pricePaid,
        team_amount: teamAmount,
        platform_amount: platformAmount,
        payment_status: 'paid',
        stripe_session_id: session.id,
      })
      .select()
      .single();

    if (cardErr) {
      // 23505 = unique violation. Stripe delivers the same event more
      // than once by design. This session already has a card, so this
      // is not a failure — acknowledge and stop rather than creating
      // a duplicate.
      if (cardErr.code === '23505') {
        console.log(`Session ${session.id} already processed, skipping`);
        return res.status(200).send('ok (already processed)');
      }
      throw cardErr;
    }

    // One row per coupon tab, numbered from 1, all sealed.
    const tabRows = Array.from({ length: design.tab_count }, (_, i) => ({
      card_id: card.id,
      tab_number: i + 1,
      status: 'sealed',
    }));

    const { error: tabsErr } = await supabase.from('card_tabs').insert(tabRows);
    if (tabsErr) throw tabsErr;

    console.log(`Card ${card.card_token} created — ${design.tab_count} tabs, $${teamAmount} to team, payment ${session.id}`);
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
    const { design_id, campaign_id, player_id, buyer_name, success_url, cancel_url } = req.body;
    if (!design_id) return res.status(400).json({ error: 'design_id is required' });
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });

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
        quantity: 1,
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

function randToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Payment server listening on ${port}`));
