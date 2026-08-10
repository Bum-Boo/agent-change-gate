# Commercialization plan

Current verdict: viable as a focused open-source product, not yet proven as a donation business. Do not spend on branding, ads, or paid infrastructure until external retention is demonstrated.

## Positioning

Lead with one promise:

> Not another vault-wide AI assistant. Agent Change Gate is the review-before-write ACP client for focused note edits.

Hermes is the first-class setup path, not the whole category. The defensible value is the combination of durable note/agent threads, explicit scope receipts, bounded complete diffs, stale-response protection, and reversible host-side editing. Normal comparisons are exact; work-limit fallbacks are coarse but complete. The product must never imply that the separate agent process is OS-sandboxed.

## Suggested model

Start with an MIT-licensed core and treat sponsorship as validation, not projected income:

- free plugin and reproducible builds;
- GitHub Sponsors or another transparent donation page;
- sponsor recognition, transparent roadmap input, and optional early builds;
- no safety fixes, privacy controls, or basic agent support behind a paywall.

If sustained demand appears, the more credible paid path is separate and clearly optional: managed team policy packs, signed enterprise deployment, compatibility support, or audited organization presets. Do not turn note privacy or security fixes into an upsell.

## Evidence gate before monetization work

Run a four-week external beta with at least ten people who are not the maintainer. Continue investing only if:

- at least 70% complete setup without live help;
- at least 50% reach one successful response and one reviewed edit;
- at least five users return in a second week;
- at least three users say the review gate, not generic chat, is the reason they would keep it;
- no high-severity boundary or data-loss issue remains open.

One sponsor is encouraging, not market validation. Three unrelated voluntary sponsors or one paid support request is a stronger signal to test a commercial layer.

## Public beta gate

- [x] Independent source tree outside the live personal vault plugin folder
- [x] No personal absolute path in source or manifest
- [x] Canonical `hermes -p <profile> acp` launch
- [x] Diff-before-write and stale-note protection
- [x] Bounded complete line diff and request cancellation
- [x] Scope receipts omit instruction/note-body/model-response plaintext, with deterministic-hash disclosure and deletion controls
- [x] Custom argv-only ACP launch profiles
- [x] Local retention and deletion controls
- [x] README, privacy policy, security policy, license, tests, CI, and release workflow
- [x] Isolated vault deployment path
- [ ] Initial reviewed commit on public-repo-ready history
- [ ] First GitHub CI run green on the declared Node matrix
- [ ] Trademark and domain clearance before paid brand spend
- [ ] Maintainer GitHub organization/user and repository URL
- [ ] Real funding URL in `manifest.json`
- [ ] Matching `.github/FUNDING.yml`
- [ ] Product screenshots and a 30–60 second demo
- [ ] Ten external beta users across Hermes plus at least one additional ACP implementation
- [ ] Published ACP compatibility matrix with exact tested versions and operating systems
- [ ] Independent security review of the built `main.js`
- [ ] GitHub prerelease `0.2.0`
- [ ] Monitored private vulnerability-reporting channel enabled
- [ ] Obsidian Community Plugins submission

## Early validation

Track only aggregate, manually reported outcomes; do not add telemetry by default.

- setup completion rate and time-to-first-response;
- first successful agent reply;
- first reviewed edit applied;
- edits discarded because the scope was wrong;
- stale edits correctly blocked;
- weekly users who return to the same note thread;
- sponsor conversion after repeated use.

The first product decision should be based on whether users value the review-before-write flow enough to return, not on raw chat volume, stars, or launch-day downloads.
