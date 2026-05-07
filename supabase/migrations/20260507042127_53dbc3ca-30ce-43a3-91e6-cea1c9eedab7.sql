drop function if exists public.has_active_subscription(uuid, text);
drop function if exists public.get_subscription_tier(uuid, text);

create or replace function public.has_active_subscription(check_env text default 'live')
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = auth.uid()
    and environment = check_env
    and (
      (status in ('active', 'trialing') and (current_period_end is null or current_period_end > now()))
      or (status = 'canceled' and current_period_end > now())
    )
  );
$$;

create or replace function public.get_subscription_tier(check_env text default 'live')
returns text language sql stable security invoker set search_path = public as $$
  select product_id from public.subscriptions
  where user_id = auth.uid()
    and environment = check_env
    and (
      (status in ('active', 'trialing') and (current_period_end is null or current_period_end > now()))
      or (status = 'canceled' and current_period_end > now())
    )
  order by created_at desc
  limit 1;
$$;