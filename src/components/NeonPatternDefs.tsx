export function NeonPatternDefs({ colors }: { colors: string[] }) {
  const unique = [...new Set(colors)];
  return (
    <svg width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        {unique.map((color) => (
          <pattern
            key={color}
            id={`neon-${color.replace(/[^a-zA-Z0-9]/g, "")}`}
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
            patternTransform="rotate(-45)"
          >
            <rect width="6" height="6" fill={color} opacity="0.10" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="1.2" opacity="0.6" />
          </pattern>
        ))}
      </defs>
    </svg>
  );
}
