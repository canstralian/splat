import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyWebhook, EventName, type PaddleEnv } from '../_shared/paddle.ts';

let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
  }
  return _supabase;
}

async function handleSubscriptionCreated(data: Record<string, unknown>, env: PaddleEnv) {
  const { id, customerId, items, status, currentBillingPeriod, customData, scheduledChange } = data;
  const userId = customData?.userId;
  if (!userId) {
    console.error('No userId in customData');
    return;
  }
  const item = items[0];
  const priceId = item.price.importMeta?.externalId;
  const productId = item.product.importMeta?.externalId;
  if (!priceId || !productId) {
    console.warn('Skipping subscription: missing importMeta.externalId', {
      rawPriceId: item.price.id,
      rawProductId: item.product.id,
    });
    return;
  }
  await getSupabase().from('subscriptions').upsert({
    user_id: userId,
    paddle_subscription_id: id,
    paddle_customer_id: customerId,
    product_id: productId,
    price_id: priceId,
    status,
    current_period_start: currentBillingPeriod?.startsAt,
    current_period_end: currentBillingPeriod?.endsAt,
    cancel_at_period_end: scheduledChange?.action === 'cancel',
    scheduled_change_action: scheduledChange?.action ?? null,
    scheduled_change_effective_at: scheduledChange?.effectiveAt ?? null,
    environment: env,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'paddle_subscription_id' });
}

async function handleSubscriptionUpdated(data: Record<string, unknown>, env: PaddleEnv) {
  const { id, status, currentBillingPeriod, scheduledChange, items } = data;
  const item = items?.[0];
  const priceId = item?.price?.importMeta?.externalId;
  const productId = item?.product?.importMeta?.externalId;

  const update: Record<string, unknown> = {
    status,
    current_period_start: currentBillingPeriod?.startsAt,
    current_period_end: currentBillingPeriod?.endsAt,
    cancel_at_period_end: scheduledChange?.action === 'cancel',
    scheduled_change_action: scheduledChange?.action ?? null,
    scheduled_change_effective_at: scheduledChange?.effectiveAt ?? null,
    updated_at: new Date().toISOString(),
  };
  if (priceId) update.price_id = priceId;
  if (productId) update.product_id = productId;

  await getSupabase().from('subscriptions')
    .update(update)
    .eq('paddle_subscription_id', id)
    .eq('environment', env);
}

async function handleSubscriptionCanceled(data: Record<string, unknown>, env: PaddleEnv) {
  await getSupabase().from('subscriptions')
    .update({
      status: 'canceled',
      current_period_end: data.currentBillingPeriod?.endsAt ?? data.canceledAt,
      updated_at: new Date().toISOString(),
    })
    .eq('paddle_subscription_id', data.id)
    .eq('environment', env);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const url = new URL(req.url);
  const env = (url.searchParams.get('env') || 'sandbox') as PaddleEnv;
  try {
    const event = await verifyWebhook(req, env);
    switch (event.eventType) {
      case EventName.SubscriptionCreated:
        await handleSubscriptionCreated(event.data, env);
        break;
      case EventName.SubscriptionUpdated:
        await handleSubscriptionUpdated(event.data, env);
        break;
      case EventName.SubscriptionCanceled:
        await handleSubscriptionCanceled(event.data, env);
        break;
      default:
        console.log('Unhandled event:', event.eventType);
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Webhook error', { status: 400 });
  }
});
