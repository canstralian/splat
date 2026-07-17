export function neonPatternId(color: string) {
  return `neon-${color.replace(/[^a-zA-Z0-9]/g, "")}`;
}
