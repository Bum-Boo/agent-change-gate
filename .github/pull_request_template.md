## What changed

Describe the user-visible behavior and why it belongs in Agent Change Gate.

## Safety boundary

- [ ] No new filesystem, terminal, shell, or unattended-write capability is granted to the agent.
- [ ] Every plugin-mediated write remains snapshot-bound, completely reviewable, and stale-checked.
- [ ] Tests use synthetic content and no credentials, personal vault paths, or private data are included.

## Verification

- [ ] `npm run check`
- [ ] `npm audit --omit=dev`
- [ ] Relevant isolated-vault manual checks are recorded, or the missing checks are stated explicitly.
- [ ] README, privacy, security, compatibility, and release truth remain synchronized.
