/** Splat mark — irregular splat shape evoking a squashed bug */
export const StackedLogo = ({ size = 16, color = "currentColor" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M8 1.2c1.4 0 2 1.4 3.2 1.6 1.5.2 3.2.6 3.4 2.2.2 1.4-1.2 2-1 3.4.2 1.5 1.4 2.6.6 3.8-.8 1.2-2.6.6-3.8 1.4-1.2.8-1.6 2.4-3 2.2-1.5-.2-1.8-2-3.2-2.4-1.4-.4-3.2.4-3.8-.9-.6-1.3.8-2.4.6-3.8C.8 7.3-.6 6.4.2 5.1 1 3.8 2.8 4.4 4 3.6 5 2.9 5.5 1.2 8 1.2z"
      fill={color}
    />
    <circle cx="13.5" cy="3" r="0.9" fill={color} />
    <circle cx="2.5" cy="13" r="0.7" fill={color} />
    <circle cx="14" cy="12.5" r="0.6" fill={color} />
  </svg>
);
