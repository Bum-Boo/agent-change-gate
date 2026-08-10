## Summary

Describe the user-visible change and why it is needed.

## Safety impact

- [ ] Scope capture and exact-path isolation remain intact.
- [ ] Agent output still requires bounded review and explicit approval before a write.
- [ ] No credentials, vault contents, provider responses, or generated `main.js` are included.
- [ ] New or adapted third-party code has complete provenance and license notices.

## Verification

- [ ] `npm run check`
- [ ] Relevant regression tests added or updated
- [ ] Manual Obsidian behavior checked when the UI or plugin lifecycle changed
