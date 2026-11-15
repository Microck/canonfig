// Shared by the hero (a server component) and the logo strip (a client one),
// so it carries no 'use client' of its own.

import './harnesses.css';

/**
 * The harnesses Canonfig writes into (content/docs/reference/harnesses.mdx),
 * each with its logo from public/harnesses/ (sources in website/DESIGN.md).
 */
export const HARNESSES = [
  { name: 'OpenAI Codex', logo: 'openai-codex' },
  { name: 'Claude Code', logo: 'claude-code' },
  { name: 'Amp', logo: 'amp' },
  { name: 'Oh My Pi', logo: 'oh-my-pi' },
  { name: 'Pi Coding Agent', logo: 'pi' },
  { name: 'Factory Droid CLI', logo: 'factory-droid' },
  { name: 'Cursor', logo: 'cursor' },
  { name: 'Devin CLI', logo: 'devin' },
  { name: 'OpenCode', logo: 'opencode' },
  { name: 'Grok Build CLI', logo: 'grok' },
  { name: 'Google Antigravity CLI', logo: 'antigravity' },
  { name: 'GitHub Copilot CLI', logo: 'github-copilot' },
  { name: 'Kimi Code CLI', logo: 'kimi' },
  { name: 'Kilo Code CLI', logo: 'kilo-code' },
  { name: 'Hermes Agent', logo: 'hermes-agent' },
  { name: 'Qwen Code', logo: 'qwen' },
] as const;

export type HarnessLogoId = (typeof HARNESSES)[number]['logo'];

/**
 * A harness logo in the current text colour: the SVG is a mask over a filled
 * box, so every logo shares one tone however its source file was coloured.
 * Size it with `className`. Decoration; name the harness beside it or on a
 * wrapper.
 */
export function HarnessLogo({ logo, className }: { logo: HarnessLogoId; className: string }) {
  const url = `url(/harnesses/${logo}.svg)`;
  return <span className={`harness-logo ${className}`} aria-hidden="true" style={{ maskImage: url, WebkitMaskImage: url }} />;
}
