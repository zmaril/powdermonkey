// PowderMonkey mark: an orbital cannon firing a beam straight down.
// Strict three-color palette, flat and geometric — no gradients.
//   orange  beam, charged core, nozzle (the energy)
//   cream   platform, panels, arms, beam striping (the hardware)
//   ink     detail cuts on the light shapes (panel grid, core pupil)

const ORANGE = "#ff5a3d";
const CREAM = "#f0ead9";
const INK = "#20242e";

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="PowderMonkey"
    >
      {/* beam blasting straight down — a constant-width cylinder */}
      <rect x="26" y="30" width="12" height="30" fill={ORANGE} />
      {/* cream energy striping across the beam */}
      <g fill={CREAM}>
        <rect x="27.2" y="38" width="9.6" height="1.8" />
        <rect x="27.2" y="46" width="9.6" height="1.8" />
        <rect x="27.2" y="54" width="9.6" height="1.8" />
      </g>

      {/* solar panels */}
      <g fill={CREAM}>
        <rect x="2" y="10" width="12" height="10" rx="1" />
        <rect x="50" y="10" width="12" height="10" rx="1" />
      </g>
      <g stroke={INK} strokeWidth="1">
        <line x1="8" y1="10" x2="8" y2="20" />
        <line x1="2" y1="15" x2="14" y2="15" />
        <line x1="56" y1="10" x2="56" y2="20" />
        <line x1="50" y1="15" x2="62" y2="15" />
      </g>
      {/* arms */}
      <g fill={CREAM}>
        <rect x="14" y="13.5" width="6" height="3" />
        <rect x="44" y="13.5" width="6" height="3" />
      </g>

      {/* hexagonal platform body */}
      <path d="M19 15 L25.5 7 L38.5 7 L45 15 L38.5 23 L25.5 23 Z" fill={CREAM} />
      {/* charged core */}
      <circle cx="32" cy="15" r="4.5" fill={ORANGE} />
      <circle cx="32" cy="15" r="1.7" fill={INK} />

      {/* nozzle — tapers from the body into the cylinder */}
      <path d="M27 23 L37 23 L38 30 L26 30 Z" fill={ORANGE} />
    </svg>
  );
}
