// Basketball Money — payment server.
//
// This is a small always-running server, deployed as a Render "Web
// Service" (not a static site). It exists for one reason: your
// Stripe secret key has to live somewhere that isn't the browser,
// and Render's environment variables — set through their normal web
// dashboard, no terminal required — are exactly that place.
//
// Two jobs, matching the two pieces this needs:
//
// 1. POST /create-checkout-session — the "Continue to Payment"
//    button on the site calls this. It looks up the real card price
//    from the database itself (never trusts whatever price the
//    browser sends), then asks Stripe to open a real, hosted
//    Checkout page and returns that page's URL.
//
// 2. POST /webhook — Stripe calls this directly, server to server,
//    only when a payment has genuinely succeeded. This is the actual
//    security boundary: a card only gets created here, after Stripe
//    itself confirms money moved — never by the browser clicking a
//    button. That closes the gap where anyone who understood the API
//    could otherwise create a free card.

const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = express();

// Stripe's webhook needs the raw, unparsed request body to verify
// its signature — so this route gets its own raw-body handling,
// separate from the normal JSON parsing used everywhere else.
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
  const campaignId = session.metadata?.campaign_id;
  const playerId = session.metadata?.player_id || null;
  const supporterName = session.metadata?.supporter_name || 'Supporter';

  if (!campaignId) {
    console.error('Webhook fired with no campaign_id in metadata');
    return res.status(400).send('Missing campaign_id');
  }

  try {
    const token = randToken();
    const { data: card, error: cardErr } = await supabase
      .from('bm_cards')
      .insert({
        campaign_id: Number(campaignId),
        player_id: playerId ? Number(playerId) : null,
        card_token: token,
        supporter_name: supporterName,
        stripe_session_id: session.id,
      })
      .select()
      .single();

    if (cardErr) {
      // Code 23505 = unique-violation. This session already has a
      // card, meaning Stripe delivered this event more than once
      // (it does this automatically). Not a real failure — just
      // acknowledge and stop, rather than creating a second card.
      if (cardErr.code === '23505') {
        console.log(`Session ${session.id} already processed, skipping`);
        return res.status(200).send('ok (already processed)');
      }
      throw cardErr;
    }

    const stateRows = Array.from({ length: 32 }, (_, i) => ({
      card_id: card.id, position: i, state: 0,
    }));
    const { error: statesErr } = await supabase.from('bm_coupon_states').insert(stateRows);
    if (statesErr) throw statesErr;

    console.log(`Card ${token} created for campaign ${campaignId} after real payment ${session.id}`);
    res.status(200).send('ok');
  } catch (e) {
    console.error('Could not create card after payment:', e);
    // A non-200 here makes Stripe retry automatically — worth doing,
    // since a real payment already happened and the card genuinely
    // needs to exist.
    res.status(500).send('Failed to create card');
  }
});

// Every other route gets normal JSON body parsing.
app.use(express.json());

// CORS: the site itself calls this from the browser, so this needs
// to be reachable cross-origin.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { campaign_id, player_id, supporter_name, success_url, cancel_url } = req.body;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });

    const { data: campaign, error: campaignErr } = await supabase
      .from('bm_campaigns')
      .select('id, team_name, campaign_name, card_price_cents')
      .eq('id', campaign_id)
      .single();

    if (campaignErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${campaign.team_name} — Basketball Money digital card`,
            description: campaign.campaign_name,
          },
          unit_amount: campaign.card_price_cents,
        },
        quantity: 1,
      }],
      metadata: {
        campaign_id: String(campaign_id),
        player_id: player_id ? String(player_id) : '',
        supporter_name: supporter_name || 'Supporter',
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
