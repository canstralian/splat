import { useCallback } from "react";
import { neonPatternId } from "@/components/neon-pattern-id";

export function useNeonCharts() {
  /** Returns fill props for a Recharts shape (Bar Cell, Area, etc.) */
  const getFill = useCallback(
    (color: string) => ({
      fill: `url(#${neonPatternId(color)})`,
      stroke: color,
      strokeWidth: 1.5,
    }),
    []
  );

  return { getFill };
}
