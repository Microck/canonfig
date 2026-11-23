import { cornerWashPaths } from '../../../../ui/src/lib/dither/geometry';
import type { HarnessLogoId } from './harnesses';

export type Machine = { name: string; platform: string; accent: string; icon: MachineIcon; harnesses: HarnessLogoId[] };

// The demo's machines, with an illustrative mix of supported harnesses.
export const FOLLOWERS: Machine[] = [
  { name: 'laptop', platform: 'macOS', accent: 'var(--sa-dither-blue)', icon: 'laptop', harnesses: ['claude-code', 'cursor', 'openai-codex'] },
  { name: 'studio', platform: 'macOS', accent: 'var(--sa-dither-pink)', icon: 'desktop', harnesses: ['claude-code', 'opencode', 'amp'] },
  { name: 'gaming-pc', platform: 'Windows', accent: 'var(--sa-dither-green)', icon: 'gaming', harnesses: ['openai-codex', 'github-copilot', 'kimi'] },
  { name: 'build-box', platform: 'Linux', accent: 'var(--sa-dither-blue)', icon: 'server', harnesses: ['opencode', 'pi', 'hermes-agent'] },
];

// The GUI's machine icons (ui/src/components/icons.tsx, Solar linear set).
const ICON_PATHS = {
  desktop: [
    'M2 10C2 6.22876 2 4.34315 3.17157 3.17157C4.34315 2 6.22876 2 10 2H14C17.7712 2 19.6569 2 20.8284 3.17157C22 4.34315 22 6.22876 22 10V11C22 13.8284 22 15.2426 21.1213 16.1213C20.2426 17 18.8284 17 16 17H8C5.17157 17 3.75736 17 2.87868 16.1213C2 15.2426 2 13.8284 2 11V10Z',
    'M16 22H8',
    'M12 17L12 22',
    'M22 13H2',
  ],
  laptop: [
    'M19.6471 15.5357H4.35294M19.6471 15.5357V8C19.6471 6.11438 19.6471 5.17157 19.0613 4.58579C18.4755 4 17.5327 4 15.6471 4H8.35294C6.46732 4 5.52451 4 4.93873 4.58579C4.35294 5.17157 4.35294 6.11438 4.35294 8V15.5357M19.6471 15.5357L21.3911 17.3358C21.4356 17.3818 21.4579 17.4048 21.4787 17.4276C21.7998 17.7802 21.9843 18.2358 21.999 18.7124C22 18.7433 22 18.7753 22 18.8393C22 18.9885 22 19.0631 21.996 19.1261C21.9325 20.1314 21.1314 20.9325 20.1261 20.996C20.0631 21 19.9885 21 19.8393 21H4.16068C4.01148 21 3.93688 21 3.87388 20.996C2.86865 20.9325 2.06749 20.1314 2.00398 19.1261C2 19.0631 2 18.9885 2 18.8393C2 18.7753 2 18.7433 2.00096 18.7124C2.01569 18.2358 2.20022 17.7802 2.52127 17.4276C2.54208 17.4048 2.56438 17.3818 2.60888 17.3358L4.35294 15.5357',
    'M9.5 18.5H14.5',
    'M12 6.75H12.0001',
  ],
  gaming: [
    'M10.165 4.77922L10.6669 5.13443C11.0567 5.41029 11.5225 5.55844 12 5.55844C12.4776 5.55844 12.9434 5.41029 13.3332 5.13441L13.8351 4.77922C14.5514 4.27225 15.4074 4 16.2849 4H16.8974C17.3016 4 17.7099 4.02549 18.0908 4.16059C20.4735 5.00566 22.1125 8.09503 21.994 15.1026C21.9701 16.5145 21.6397 18.075 20.3658 18.6842C19.9688 18.8741 19.5033 19 18.9733 19C18.3373 19 17.8322 18.8187 17.4424 18.5632C16.5285 17.9642 15.8588 16.9639 14.8888 16.4609C14.3048 16.1581 13.6566 16 12.9989 16H11.0011C10.3434 16 9.69519 16.1581 9.11125 16.4609C8.14122 16.9639 7.47153 17.9642 6.55763 18.5632C6.1678 18.8187 5.66273 19 5.02671 19C4.49667 19 4.03121 18.8741 3.63423 18.6842C2.3603 18.075 2.02992 16.5145 2.00604 15.1026C1.88749 8.09504 3.52645 5.00566 5.90915 4.16059C6.29009 4.02549 6.69838 4 7.10257 4H7.71504C8.59264 4 9.44862 4.27225 10.165 4.77922Z',
    'M7.5 9V12M6 10.5L9 10.5',
    'M15.25 10.25H15.2501',
    'M16.75 11.75H16.7501',
    'M18.25 10.25H18.2501',
    'M16.75 8.75H16.7501',
  ],
  server: [
    'M2 17C2 15.1144 2 14.1716 2.58579 13.5858C3.17157 13 4.11438 13 6 13H18C19.8856 13 20.8284 13 21.4142 13.5858C22 14.1716 22 15.1144 22 17C22 18.8856 22 19.8284 21.4142 20.4142C20.8284 21 19.8856 21 18 21H6C4.11438 21 3.17157 21 2.58579 20.4142C2 19.8284 2 18.8856 2 17Z',
    'M2 6C2 4.11438 2 3.17157 2.58579 2.58579C3.17157 2 4.11438 2 6 2H18C19.8856 2 20.8284 2 21.4142 2.58579C22 3.17157 22 4.11438 22 6C22 7.88562 22 8.82843 21.4142 9.41421C20.8284 10 19.8856 10 18 10H6C4.11438 10 3.17157 10 2.58579 9.41421C2 8.82843 2 7.88562 2 6Z',
    'M11 6H18',
    'M6 6H8',
    'M11 17H18',
    'M6 17H8',
  ],
} as const;

export type MachineIcon = keyof typeof ICON_PATHS;

// Shared Bayer 4x4 diagonal corner wash (18x18 cells scaled to the 26-unit tile).
const TILE_CELLS = 18;
const TILE_SCALE = 26 / TILE_CELLS;
const TILE_WASH = {
  source: cornerWashPaths(TILE_CELLS, true),
  follower: cornerWashPaths(TILE_CELLS, false),
} as const;

/**
 * A machine's icon tile as the GUI's map draws it (machine-node.tsx): a 9%
 * tint of its accent, a 3-stop Bayer 4x4 diagonal corner wash carved around
 * the icon (with a top-right emitter glint on the Source), a 40% border and
 * the device icon. SVG elements in a 26-unit box at the origin, so it drops
 * into a larger SVG or into `<svg viewBox="0 0 26 26">` on its own.
 * `id` must be unique on the page: it names the tile's clip path.
 */
export function IconTile({ id, accent, icon, source = false }: { id: string; accent: string; icon: MachineIcon; source?: boolean }) {
  const paths = source ? TILE_WASH.source : TILE_WASH.follower;
  return (
    <>
      <defs>
        <clipPath id={id}>
          <rect width="26" height="26" rx="5" />
        </clipPath>
      </defs>
      <rect width="26" height="26" rx="5" fill={accent} fillOpacity="0.09" />
      <g clipPath={`url(#${id})`}>
        <g className="dither-cells" transform={`scale(${TILE_SCALE})`}>
          <path d={paths[0]} fill={accent} fillOpacity="0.28" />
          <path d={paths[1]} fill={accent} fillOpacity="0.72" />
          <path d={paths[2]} fill={`color-mix(in oklab, ${accent} 64%, var(--sa-12))`} />
        </g>
      </g>
      <rect x="0.5" y="0.5" width="25" height="25" rx="4.5" fill="none" stroke={accent} strokeOpacity="0.4" />
      <g transform="translate(5 5) scale(0.667)" fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[icon].map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </>
  );
}
