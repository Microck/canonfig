## Summary

- What changed:
- Why:
- Fixes #

## Verification

List what you ran and what happened. Tick only what you actually ran.

- [ ] `npm run typecheck`
- [ ] `npm run lint` (also validates docs command examples and skills)
- [ ] `npm test`, or the focused test files: 
- [ ] `npm --prefix ui run typecheck` and `npm --prefix ui run lint` (browser UI changes)
- [ ] UI tests (browser UI changes): `TSX_TSCONFIG_PATH=ui/tsconfig.app.json node --import tsx --test <files>`
- [ ] A new or changed test fails without this change and passes with it
- [ ] Manual check, with steps:

## Docs and compatibility

- [ ] Docs, README or skills updated where user-visible behavior changed
- [ ] Breaking change (command, exit code, file format, browser UI flow), described above
- [ ] No credentials, tokens, invitation envelopes, `secrets.json` or personal config committed

## AI assistance disclosure

Required for AI-assisted changes; see [CONTRIBUTING.md](https://github.com/Microck/canonfig/blob/main/CONTRIBUTING.md#ai-assisted-contributions). Delete this section if no AI was used.

- `agent_name`:
- `agent_version`:
- `model_used`:
- `human_testing`:
- `contribution_summary`:
