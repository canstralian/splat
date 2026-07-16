import { invokeEdgeFunction } from "@/integrations/edge-functions/client";
import type { PaddleEnvironment } from "@/integrations/edge-functions/types";

const clientToken = import.meta.env.VITE_PAYMENTS_CLIENT_TOKEN as string | undefined;

interface PaddleGlobal {
  Environment: { set: (env: "sandbox" | "production") => void };
  Initialize: (opts: { token: string }) => void;
  Checkout: {
    open: (opts: Record<string, unknown>) => void;
    close?: () => void;
  };
}

declare global {
  interface Window {
    Paddle: PaddleGlobal;
  }
}

export function getPaddleEnvironment(): PaddleEnvironment {
  return clientToken?.startsWith("test_") ? "sandbox" : "live";
}

let paddleInitialized = false;
let initPromise: Promise<void> | null = null;

export async function initializePaddle() {
  if (paddleInitialized) return;
  if (initPromise) return initPromise;
  if (!clientToken) throw new Error("VITE_PAYMENTS_CLIENT_TOKEN is not set");

  initPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    script.onload = () => {
      const paddleJsEnv = getPaddleEnvironment() === "sandbox" ? "sandbox" : "production";
      window.Paddle.Environment.set(paddleJsEnv);
      window.Paddle.Initialize({ token: clientToken });
      paddleInitialized = true;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return initPromise;
}

export async function getPaddlePriceId(priceId: string): Promise<string> {
  const environment = getPaddleEnvironment();
  const data = await invokeEdgeFunction("get-paddle-price", { priceId, environment });
  if (!data?.paddleId) throw new Error(`Failed to resolve price: ${priceId}`);
  return data.paddleId;
}

export const PRICING = {
  pro: {
    productId: "splat_pro",
    name: "Pro",
    monthly: { priceId: "splat_pro_monthly", amount: 12, label: "$12/mo" },
    yearly: { priceId: "splat_pro_yearly", amount: 120, label: "$120/yr" },
  },
  team: {
    productId: "splat_team",
    name: "Team",
    monthly: { priceId: "splat_team_monthly", amount: 39, label: "$39/mo" },
    yearly: { priceId: "splat_team_yearly", amount: 390, label: "$390/yr" },
  },
} as const;
