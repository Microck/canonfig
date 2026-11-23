import type { ReactNode } from 'react';
import { FillPattern } from '../dither';
import { IconTile, type MachineIcon } from './machine';
import { Offscreen } from './offscreen';
import './safety.css';

/**
 * Four properties of a sync, each drawn as the piece of the canonfig GUI that
 * shows it: the Backups list, the machine map, and the item-by-machine matrix.
 * The pictures are SVG so they scale as one, and their textures are the GUI's
 * dither fills. Each plays its story on a loop (safety.css), paused while off
 * screen. Names and states follow the interactive demo
 * (ui/src/shared/data.ts); the behaviour is canonfig 7.1.9's.
 */
export default function SafetyCards() {
  return (
    <Offscreen className="sf-films">
      <ul className="sf">
        <Card index={0} title="Back up existing files" caption="Canonfig backs up each agent's files before its first write." href="/docs/how-to/restore-from-a-backup/">
          <BackupsPicture />
        </Card>
        <Card
          index={1}
          title="Keep your edits"
          caption="Canonfig pauses updates to files you edit by hand."
          href="/docs/how-to/recover/#resolve-follower-drift"
        >
          <DriftPicture />
        </Card>
        <Card
          index={2}
          title="Choose what each machine gets"
          caption="Assign items to groups of machines."
          href="/docs/reference/canonfig-folder/#groups"
        >
          <MatrixPicture />
        </Card>
        <Card index={3} title="Sync in one direction" caption="Follower machines pull changes from your source machine." href="/docs/explanation/architecture/">
          <OneWayPicture />
        </Card>
      </ul>
    </Offscreen>
  );
}

/** One card; `index` staggers its rise when the section scrolls into view (page.css). */
function Card({ index, title, caption, href, children }: { index: number; title: string; caption: string; href: string; children: ReactNode }) {
  return (
    <li className="rv" style={{ '--rv': `${80 + index * 60}ms` }}>
      <a className="sf-card" href={href}>
        <span className="sf-art">{children}</span>
        <span className="sf-title">{title}</span>
        <span className="sf-caption">{caption}</span>
      </a>
    </li>
  );
}

// ------------------------------------------------------------------ backups --

const SNAPSHOTS = [
  { date: '2026-10-24', harnesses: 'Oh My Pi', restored: true },
  { date: '2026-10-19', harnesses: 'GitHub Copilot CLI', restored: false },
  {
    date: '2026-09-02',
    harnesses: 'Codex, Claude Code',
    restored: false,
    first: true,
  },
] as const;

/** The Backups page: snapshots, the harnesses each holds, and Restore. */
function BackupsPicture() {
  return (
    <svg className="sf-svg" viewBox="0 0 360 180" aria-hidden="true">
      <g transform="translate(0 16)">
        <text className="sf-th" x="0" y="12">
          Snapshot
        </text>
        <text className="sf-th" x="140" y="12">
          Harnesses
        </text>
        <line className="sf-rule" x1="0" x2="360" y1="22" y2="22" />
        {SNAPSHOTS.map((snapshot, index) => {
          const y = 24 + index * 40;
          return (
            <g key={snapshot.date} transform={`translate(0 ${y})`}>
              <text className="sf-mono" x="0" y="24">
                {snapshot.date}
              </text>
              {'first' in snapshot ? (
                <g transform="translate(70 14)">
                  <rect className="sf-tag" width="56" height="14" rx="3" />
                  <text className="sf-tag-text" x="28" y="10" textAnchor="middle">
                    First, kept
                  </text>
                </g>
              ) : null}
              <text className="sf-td" x="140" y="24">
                {snapshot.harnesses}
              </text>
              {/* The two newest rows trade places on hover: the restore the
                  card describes runs on the second one. */}
              <RestoreButton restored={snapshot.restored} swaps={index < 2} />
              <line className="sf-rule" x1="0" x2="360" y1="40" y2="40" />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------- the map --

type Status = { tone: 'ok' | 'warn' | 'muted'; label: string };

/**
 * One machine as the map draws it: a dithered icon tile in the machine's
 * accent, its name and role, and a footer with its revision and state.
 */
function MachineNode({
  id,
  x,
  y,
  width,
  name,
  role,
  accent,
  icon,
  revision,
  status,
  ring,
}: {
  id: string;
  x: number;
  y: number;
  width: number;
  name: string;
  role?: string;
  accent: string;
  icon: MachineIcon;
  revision?: string;
  status: Status;
  /** A ring that lights as a sync pulse lands, `delay` ms into the loop. */
  ring?: { tone: 'ok' | 'warn'; delay: number };
}) {
  const height = 66;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className="sf-node" width={width} height={height} rx="6" />
      {ring ? <rect className={`sf-ring sf-ring-${ring.tone}`} x="-1" y="-1" width={width + 2} height={height + 2} rx="7" style={{ '--sweep': `${ring.delay}ms` }} /> : null}
      <g transform="translate(10 10)">
        <IconTile id={`${id}-tile`} accent={accent} icon={icon} source={status.label === 'Source'} />
      </g>
      <text className={role ? 'sf-node-name' : 'sf-node-name sf-node-name-compact'} x="44" y={role ? 21 : 27}>
        {name}
      </text>
      {role ? (
        <text className="sf-node-role" x="44" y="33">
          {role}
        </text>
      ) : null}
      <line className="sf-rule" x1="0" x2={width} y1="44" y2="44" />
      {/* HTML, so the browser lays out the revision and the state word: SVG
          text cannot be measured on the server to place the mark beside it. */}
      <foreignObject x="0" y="44" width={width} height={height - 44}>
        <div className="sf-foot">
          {revision ? <span className="sf-foot-rev">{revision}</span> : null}
          <span className={`sf-state sf-state-${status.tone}`}>
            {status.tone === 'muted' ? null : <StatusMark tone={status.tone} />}
            {status.label}
          </span>
        </div>
      </foreignObject>
    </g>
  );
}

/** The GUI's StatusMark: a filled check for up to date, a half-filled ring for edited there. */
function StatusMark({ tone }: { tone: 'ok' | 'warn' }) {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14">
      {tone === 'ok' ? (
        <>
          <circle cx="7" cy="7" r="6" className="sf-mark-fill" />
          <path d="M4.4 7.2 6.2 9 9.6 5.3" className="sf-mark-check" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="5.25" className="sf-mark-ring" />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" className="sf-mark-fill" />
        </>
      )}
    </svg>
  );
}

/**
 * A map edge: a soft curve from one node's bottom to another's top, with an
 * arrowhead, plus a pulse that runs down it when its card is hovered or
 * focused (safety.css). `pathLength` makes the pulse's dash a share of the
 * curve, whatever its length.
 */
function Edge({ from, to, tone, pulseDelay = 0 }: { from: [number, number]; to: [number, number]; tone: 'ok' | 'warn'; pulseDelay?: number }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const bend = (y2 - y1) / 2;
  const curve = `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2 - 1}`;
  return (
    <g className={`sf-edge sf-edge-${tone}`}>
      <path d={curve} />
      <path d={`M${x2 - 3.5} ${y2 - 5} L${x2} ${y2 - 1} L${x2 + 3.5} ${y2 - 5}`} />
      <path className="sf-pulse" d={curve} pathLength={100} style={{ '--sweep': `${pulseDelay}ms` }} />
    </g>
  );
}

/**
 * Restore… and Restored drawn on top of each other. `restored` is the resting
 * state; `swaps` cross-fades to the other state while the card is hovered.
 */
function RestoreButton({ restored, swaps }: { restored: boolean; swaps: boolean }) {
  const states = [
    { done: restored, role: 'sf-swap-now' },
    { done: !restored, role: 'sf-swap-next' },
  ];
  return (
    <g className={swaps ? 'sf-restore sf-restore-swaps' : 'sf-restore'}>
      {(swaps ? states : states.slice(0, 1)).map(({ done, role }) => (
        <g key={role} className={role}>
          <rect className={done ? 'sf-button sf-button-done' : 'sf-button'} x="280" y="8" width="80" height="24" rx="4" />
          <text className={done ? 'sf-button-text sf-button-text-done' : 'sf-button-text'} x="320" y="24" textAnchor="middle">
            {done ? 'Restored' : 'Restore…'}
          </text>
        </g>
      ))}
    </g>
  );
}

const SOURCE = {
  name: 'atlas',
  role: 'Linux · Source',
  accent: 'var(--sa-dither-purple)',
  icon: 'desktop',
} as const;

/** The map with one edge gone amber: studio's copy was edited there. */
function DriftPicture() {
  return (
    <svg className="sf-svg" viewBox="0 0 360 180" aria-hidden="true">
      <Edge from={[90, 76]} to={[262, 112]} tone="warn" />
      <MachineNode id="drift-atlas" x={0} y={10} width={180} {...SOURCE} revision="rev 7" status={{ tone: 'muted', label: 'Source' }} />
      <MachineNode
        id="drift-studio"
        x={162}
        y={112}
        width={198}
        name="studio"
        role="macOS · Design studio"
        accent="var(--sa-dither-pink)"
        icon="desktop"
        revision="rev 7"
        status={{ tone: 'warn', label: 'Edited on that machine' }}
        ring={{ tone: 'warn', delay: 0 }}
      />
    </svg>
  );
}

const FOLLOWERS = [
  { name: 'laptop', accent: 'var(--sa-dither-blue)', icon: 'laptop' },
  { name: 'studio', accent: 'var(--sa-dither-pink)', icon: 'desktop' },
  { name: 'gaming-pc', accent: 'var(--sa-dither-green)', icon: 'gaming' },
] as const;

/** The Source feeding every follower; nothing flows back up. */
function OneWayPicture() {
  return (
    <svg className="sf-svg" viewBox="0 0 360 180" aria-hidden="true">
      {FOLLOWERS.map((follower, index) => (
        <Edge key={follower.name} from={[180, 76]} to={[58 + index * 122, 112]} tone="ok" pulseDelay={index * 90} />
      ))}
      <MachineNode id="one-atlas" x={90} y={10} width={180} {...SOURCE} revision="rev 8" status={{ tone: 'muted', label: 'Source' }} />
      {FOLLOWERS.map((follower, index) => (
        <MachineNode
          key={follower.name}
          id={`one-${follower.name}`}
          x={index * 122}
          y={112}
          width={116}
          {...follower}
          status={{ tone: 'ok', label: 'Up to date' }}
          ring={{ tone: 'ok', delay: index * 90 }}
        />
      ))}
    </svg>
  );
}

// ------------------------------------------------------------- the matrix --

type Cell = 'ok' | 'warn' | 'none';

// The demo's matrix rows (ui/src/shared/data.ts), three of its followers.
const MATRIX: { item: string; cells: [Cell, Cell, Cell] }[] = [
  { item: 'instructions', cells: ['ok', 'ok', 'ok'] },
  { item: 'skills/code-review', cells: ['ok', 'warn', 'ok'] },
  { item: 'tools/cuda-toolkit', cells: ['none', 'none', 'ok'] },
  { item: 'credentials/github-token', cells: ['ok', 'none', 'none'] },
];

const CELL_FILL = {
  ok: 'url(#mx-solid)',
  warn: 'url(#mx-hatched)',
  none: 'url(#mx-dotted)',
} as const;

/** Overview's item-by-machine matrix: solid up to date, hatched edited there, dotted not sent. */
function MatrixPicture() {
  const column = (index: number) => 150 + index * 70;
  return (
    <svg className="sf-svg" viewBox="0 0 360 180" aria-hidden="true">
      <g transform="translate(0 15)">
        <defs>
          <FillPattern id="mx-solid" fill="solid" color="var(--sa-dither-green)" />
          <FillPattern id="mx-hatched" fill="hatched" color="var(--sa-warn)" />
          <FillPattern id="mx-dotted" fill="dotted" color="var(--sa-9)" />
        </defs>
        {FOLLOWERS.map((follower, index) => (
          <text key={follower.name} className="sf-th" x={column(index)} y="12">
            {follower.name}
          </text>
        ))}
        {MATRIX.map((row, rowIndex) => {
          const y = 22 + rowIndex * 22;
          return (
            <g key={row.item}>
              <text className="sf-td" x="0" y={y + 12}>
                {row.item}
              </text>
              {row.cells.map((cell, index) => (
                <rect
                  key={`${row.item}-${follower(index)}`}
                  className={`sf-cell sf-cell-${cell}`}
                  x={column(index)}
                  y={y + 2}
                  width="66"
                  height="14"
                  rx="3"
                  fill={CELL_FILL[cell]}
                  // A sweep across the grid on hover: down the rows, along the machines.
                  style={{ '--sweep': `${rowIndex * 45 + index * 70}ms` }}
                />
              ))}
            </g>
          );
        })}
        <g transform="translate(0 128)">
          <Legend x={0} fill="url(#mx-solid)" faded label="Up to date" />
          <Legend x={92} fill="url(#mx-hatched)" label="Edited on that machine" />
          <Legend x={252} fill="url(#mx-dotted)" label="Not sent" />
        </g>
      </g>
    </svg>
  );
}

const follower = (index: number) => FOLLOWERS[index]?.name ?? index;

function Legend({ x, fill, label, faded = false }: { x: number; fill: string; label: string; faded?: boolean }) {
  return (
    <g transform={`translate(${x} 0)`}>
      <rect width="18" height="10" rx="2" fill={fill} opacity={faded ? 0.3 : 1} />
      <text className="sf-legend" x="24" y="9">
        {label}
      </text>
    </g>
  );
}
