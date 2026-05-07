import { createClient } from 'npm:@supabase/supabase-js@2';
import { getPaddleClient, gatewayFetch, type PaddleEnv } from '../_shared/paddle.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) return new Response('Unauthorized', { status: 401, headers: corsHeaders });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } }
    );
    const { data: userData } = await supabase.auth.getUser();
    const user = userData?.user;
    if (!user) return new Response('Unauthorized', { status: 401, headers: corsHeaders });

    const { action, newPriceId, environment } = await req.json();
    const env = (environment === 'live' ? 'live' : 'sandbox') as PaddleEnv;

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: sub } = await admin
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('environment', env)
      .in('status', ['active', 'trialing', 'past_due'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sub) return new Response(JSON.stringify({ error: 'No active subscription' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

    const paddle = getPaddleClient(env);

    if (action === 'cancel') {
      // End-of-period cancel
      await paddle.subscriptions.cancel(sub.paddle_subscription_id, { effectiveFrom: 'next_billing_period' });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'resume') {
      // Remove scheduled cancel
      const res = await gatewayFetch(env, `/subscriptions/${sub.paddle_subscription_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_change: null }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Resume failed: ${body}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'change_plan') {
      // Resolve new price's Paddle internal ID
      const priceRes = await gatewayFetch(env, `/prices?external_id=${encodeURIComponent(newPriceId)}`);
      const priceData = await priceRes.json();
      if (!priceData.data?.length) throw new Error('Price not found');
      const paddlePriceId = priceData.data[0].id;

      // End-of-period change with no immediate billing
      const res = await gatewayFetch(env, `/subscriptions/${sub.paddle_subscription_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [{ price_id: paddlePriceId, quantity: 1 }],
          proration_billing_mode: 'do_not_bill',
          on_payment_failure: 'prevent_change',
        }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Change plan failed: ${body}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
