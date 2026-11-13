# Brand treatments in round 2

Accessed 2026-11-13. These are design experiments, not cleared brand usage. The original film artwork is not an official asset pack. A colour observed in an official SVG does not grant permission to recolour a logo or fill a card with it.

## Palette evidence

`ui/src/proto/map-harnesses/parts.tsx` keeps brand identity separate from Canonfig's state tokens. All new declarations use OKLCH. Neutral white is deliberate where no single verified accent was selected, not a claimed official brand colour.

| Harness | Evidence | Prototype tile/card accent | Limits |
| --- | --- | --- | --- |
| Claude Code | [Anthropic's own palette](https://github.com/anthropics/skills/blob/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/brand-guidelines/SKILL.md) gives primary orange `#D97757`. | `oklch(0.672 0.131 38.8)` | Palette is company-level, not permission to modify the Claude mark. |
| OpenAI Codex | [OpenAI brand page](https://openai.com/brand/) was blocked with HTTP 403. Search results are not policy evidence. | Neutral white | No Codex-specific chromatic palette or modification permission verified. |
| Cursor | [Official brand page](https://cursor.com/brand) and its [SVG](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/brand-logo-1.svg) use `#EDECEC` on `#1B1913`. | `oklch(0.944 0.001 17.2)` | Supplied 2D and 2.5D assets exist; the page does not grant arbitrary recolouring or dithering. |
| OpenCode | [Brand guidelines](https://opencode.ai/brand) specify dark-background ink `#EEEEEE`, secondary `#AEAEAE`, shade `#4B4B4B`. | `oklch(0.949 0 0)` | Logo colours are for logos/wordmarks only, not backgrounds. Coloured cards are experiments, not approved usage. |
| GitHub Copilot CLI | [GitHub brand toolkit](https://brand.github.com/foundations/logo) specifies permitted logo colours and product lockups. | Neutral white | Film's standalone Copilot mark is deprecated in the current toolkit. Replace it with an approved current asset before promotion. |
| Amp | [Official favicon](https://ampcode.com/favicon.svg?v=2) contains a `#526044` gradient stop, cream `#DFDFC1` wordmark, and dark green background. | `oklch(0.469 0.047 129.6)` | An observed background accent, not a normative single-colour brand specification. Film's red arrow is not the current favicon. |
| Factory Droid | Targeted official-site search found no public palette or logo policy. [Factory](https://factory.com/) remains the primary product source. | Neutral white | Do not call the film's orange an official Droid colour. |
| Grok Build | No brand-specific palette or alteration permission verified in this round. | Neutral white | Film artwork remains reference material only. |
| Oh My Pi | [Repository icon](https://raw.githubusercontent.com/can1357/oh-my-pi/main/assets/icon.svg) uses `#F97316`, `#FAFAFA`, and `#0D0D0D`. | `oklch(0.705 0.187 47.6)` | Observed asset colours; no separate trademark policy verified. |
| Pi | [Product SVG](https://pi.dev/logo-auto.svg) includes `#F09082`, `#4D9ABF`, and `#F1BE58`. | `oklch(0.751 0.119 29)` | One observed accent selected, not a claim of a single official brand colour. |
| Kimi | [Official repository icon](https://raw.githubusercontent.com/MoonshotAI/kimi-code/main/apps/vscode/webview-ui/public/kimi-logo.png) is black/white with a blue dot. | Neutral white | No numeric blue palette or alteration permission claimed. |
| Qwen Code | [Official repository SVG](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/desktop/bootstrap/qwen-code-logo.svg) uses `#082DFF`. | `oklch(0.479 0.295 264.6)` | Qwen Code asset blue, not the broader Qwen model family's purple. |
| Gemini CLI | [Official brand kit](https://geminicli.com/brand-kit/) supplies full-colour and monotone assets. | Neutral white | A multicolour gradient has no single canonical tile colour. The prototype uses the official full-colour icon, resized to 128px, and the supplied transparent monochrome SVG for masks. Gemini remains unsupported in the researched Canonfig revision. |

The prototype's other twelve original glyphs are the film mesh exports recorded in `extract-logos.py`. Monochrome and dither use those exports' alpha masks. Gemini uses the [supplied monochrome SVG](https://geminicli.com/brandassets/gemini-cli-icon_monotone_on_dark.svg), because masking its opaque full-colour backdrop hides the terminal glyph. Brand tiles use dark glyphs on light accents and white glyphs on Amp and Qwen for contrast.

## Restrictions that matter before promotion

- [Anthropic trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines): prior approval, supplied images, no alterations to colour/font/proportion, readable backgrounds and clear space, no implied endorsement.
- [OpenCode brand guidelines](https://opencode.ai/brand): no new colours, gradient fills, tone swaps, glows, outlines or distortion. Logo ink must not become other text or background colours. Fixed 4:5 proportions and minimum 16 x 20px apply. This prototype's film-derived square tile and dither do not establish compliance.
- [GitHub logo guidance](https://brand.github.com/foundations/logo): no effects, distortion, low contrast, or modifications to permitted logos. The current page deprecates the standalone Copilot icon. Use an approved product lockup and permitted integration presentation.
- [Gemini CLI logo/icon guidelines](https://geminicli.com/brandassets/gemini_cli_logo_icon_guidelines.pdf): assets must not be altered; use supplied gradient only on the icon, not elsewhere; do not substitute newer Gemini colours. Using a supplied monochrome shape does not authorize the prototype's recolouring, tile and dither treatments.
- [Google general product-icon guidance](https://partnermarketinghub.withgoogle.com/brands/google/branding-guidelines/how-to-show-googles-brand/#product-icons): identify the product in context, keep your brand more prominent, and use the permission/product-compatibility process. The CLI-specific kit is more relevant than guessing rules from the Google G.
- [Cursor brand page](https://cursor.com/brand): use the proper name and supplied asset formats. No unverified permission is inferred from the download link.

No approvals were requested. For brands without a verified policy, lack of a restriction in this research does not mean permission. Do not promote the stylized treatments automatically after a visual choice.

## Collisions with status colours

- Claude orange and OMP orange can resemble warnings or drift; Pi coral can resemble apply failure. Amp green can resemble success. Qwen blue can resemble an action-required state.
- The film's chosen colours introduce further collisions: OpenCode green, Amp red, OMP purple and Copilot pink are film art directions, not a verified brand palette.
- Brand colour never changes the semantic status token, icon or text. Every status has all three. Stale reports use muted last-reported text; `clientLoaded` remains not verified.
- Status text sits on black. Harness names use a neutral backing on coloured cards. This is necessary at the high end of the 0-50% tint range, where white/neutral brand fills otherwise reduce name contrast below 4.5:1.
- Dither introduces noise at fit zoom. It is static, not animated. Colourless cards remain available for direct comparison; no favourite has been selected.

## Source retrieval limits

Kagi subscriber search worked. Its extractor returned HTTP 401 despite configured authentication; status was inspected, no credentials changed. Direct primary-source reads supplied the evidence above. OpenAI's body remained inaccessible. Google reader extraction initially selected an RSS document instead of the page body; raw HTML exposed the actual guidance and the bad extraction was reported. No paid upgrade, private dashboard, login or external message was used.
