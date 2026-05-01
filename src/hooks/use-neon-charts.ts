import { useCallback } from "react";
import { neonPatternId } from "@/components/NeonPatternDefs";

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
