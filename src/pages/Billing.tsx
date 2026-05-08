import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/useSubscription";
import { usePaddleCheckout } from "@/hooks/usePaddleCheckout";
import { PRICING, getPaddleEnvironment } from "@/lib/paddle";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { invokeEdgeFunction } from "@/integrations/edge-functions/client";
import type { UpdateSubscriptionRequest } from "@/integrations/edge-functions/types";
import { toast } from "sonner";
import { Check, ArrowLeft } from "lucide-react";

type Cycle = "monthly" | "yearly";

export default function Billing() {
  const { user } = useAuth();
  const { subscription, isActive, tier, refetch } = useSubscription(user?.id);
  const { openCheckout, loading: checkoutLoading } = usePaddleCheckout();
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();

  useEffect(() => {
    if (params.get("checkout") === "success") {
      toast.success("Payment successful — your plan is updating now.");
    }
  }, [params]);

  const buy = async (priceId: string) => {
    if (!user) return;
    await openCheckout({
      priceId,
      userId: user.id,
      customerEmail: user.email ?? undefined,
    });
  };

  const callAction = async (
    payload: Omit<UpdateSubscriptionRequest, "environment">,
    successMsg: string,
  ) => {
    setBusy(true);
    try {
      await invokeEdgeFunction("update-subscription", {
        ...payload,
        environment: getPaddleEnvironment(),
      } as UpdateSubscriptionRequest);
      toast.success(successMsg);
      setTimeout(refetch, 1500);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => callAction({ action: "cancel" }, "Cancellation scheduled at end of period");
  const resume = () => callAction({ action: "resume" }, "Subscription resumed");
  const changePlan = (newPriceId: string) =>
    callAction({ action: "change_plan", newPriceId }, "Plan updated — no immediate charge, new price applies from next renewal");

  const currentPriceId = subscription?.price_id;

  const plans = [
    {
      key: "free" as const,
      name: "Free",
      blurb: "For trying things out",
      price: "$0",
      sub: "forever",
      features: ["Up to 25 bugs", "1 project", "Solo workspace"],
    },
    {
      key: "pro" as const,
      name: "Pro",
      blurb: "For solo developers",
      price: cycle === "monthly" ? PRICING.pro.monthly.label : PRICING.pro.yearly.label,
      sub: cycle === "yearly" ? "billed yearly" : "billed monthly",
      features: ["Unlimited bugs", "Unlimited projects", "Full audit log", "Priority email support"],
      priceId: cycle === "monthly" ? PRICING.pro.monthly.priceId : PRICING.pro.yearly.priceId,
    },
    {
      key: "team" as const,
      name: "Team",
      blurb: "For small studios",
      price: cycle === "monthly" ? PRICING.team.monthly.label : PRICING.team.yearly.label,
      sub: cycle === "yearly" ? "billed yearly" : "billed monthly",
      features: ["Everything in Pro", "Team invites & roles", "Shared projects", "Audit log for the whole team"],
      priceId: cycle === "monthly" ? PRICING.team.monthly.priceId : PRICING.team.yearly.priceId,
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <PaymentTestModeBanner />
      <div className="max-w-5xl mx-auto px-4 py-10">
        <Link to="/dashboard" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>

        <h1 className="text-3xl font-bold mb-2">Billing & plans</h1>
        <p className="text-muted-foreground mb-8">Choose the plan that fits your team.</p>

        {subscription && (
          <Card className="p-5 mb-8 border-primary/30">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Current plan</span>
                  <Badge variant="secondary">{tier.toUpperCase()}</Badge>
                  <Badge variant="outline">{subscription.status}</Badge>
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {subscription.cancel_at_period_end
                    ? `Cancels on ${new Date(subscription.current_period_end!).toLocaleDateString()}`
                    : subscription.scheduled_change_action
                      ? `Change scheduled for ${new Date(subscription.scheduled_change_effective_at!).toLocaleDateString()}`
                      : subscription.current_period_end
                        ? `Renews ${new Date(subscription.current_period_end).toLocaleDateString()}`
                        : null}
                </div>
              </div>
              <div className="flex gap-2">
                {subscription.cancel_at_period_end ? (
                  <Button variant="outline" size="sm" onClick={resume} disabled={busy}>
                    Resume subscription
                  </Button>
                ) : isActive && subscription.status !== "canceled" ? (
                  <Button variant="outline" size="sm" onClick={cancel} disabled={busy}>
                    Cancel subscription
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        )}

        <div className="flex justify-center mb-6">
          <div className="inline-flex border rounded-md p-1 bg-muted">
            <button
              onClick={() => setCycle("monthly")}
              className={`px-4 py-1.5 text-sm rounded ${cycle === "monthly" ? "bg-background shadow-sm" : ""}`}
            >
              Monthly
            </button>
            <button
              onClick={() => setCycle("yearly")}
              className={`px-4 py-1.5 text-sm rounded ${cycle === "yearly" ? "bg-background shadow-sm" : ""}`}
            >
              Yearly <span className="text-primary text-xs ml-1">−2 months</span>
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          {plans.map((plan) => {
            const isCurrent = plan.priceId === currentPriceId && isActive;
            const isCurrentTier = plan.key === tier;
            return (
              <Card key={plan.key} className={`p-6 flex flex-col ${isCurrent ? "border-primary" : ""}`}>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  {isCurrent && <Badge>Current</Badge>}
                </div>
                <p className="text-sm text-muted-foreground mb-4">{plan.blurb}</p>
                <div className="mb-1 text-3xl font-bold">{plan.price}</div>
                <div className="text-xs text-muted-foreground mb-5">{plan.sub}</div>
                <ul className="space-y-2 mb-6 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {plan.key === "free" ? (
                  <Button variant="outline" disabled className="w-full">
                    {tier === "free" ? "Current plan" : "Included"}
                  </Button>
                ) : isCurrent ? (
                  <Button variant="outline" disabled className="w-full">Current plan</Button>
                ) : isActive && subscription && plan.priceId ? (
                  <Button
                    className="w-full"
                    onClick={() => changePlan(plan.priceId!)}
                    disabled={busy}
                  >
                    {isCurrentTier ? `Switch to ${cycle}` : tier === "team" ? "Downgrade" : "Upgrade"}
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    onClick={() => plan.priceId && buy(plan.priceId)}
                    disabled={checkoutLoading || !plan.priceId}
                  >
                    Get {plan.name}
                  </Button>
                )}
              </Card>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground mt-8 text-center">
          Cancellations and plan changes take effect at the end of the current billing period — you keep what you paid for.
        </p>
      </div>
    </div>
  );
}
