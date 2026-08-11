# Commercialization plan

Current verdict: viable as a focused open-source product, not yet proven as a donation business. Do not spend on branding, ads, or paid infrastructure until external retention is demonstrated.

## Positioning

Lead with one promise:

> Not another vault-wide AI assistant. Agent Change Gate is the review-before-write ACP client for focused note edits.

For the unreleased `0.3.0` branch, sharpen that promise rather than replacing it:

> Not an unattended vault agent. Agent Change Gate is the review-before-write ACP client for one note or a bounded, user-selected batch.

Hermes is the first-class setup path, not the whole category. The defensible value is the combination of durable note/agent threads, explicit scope receipts, bounded complete diffs, stale-response protection, and guarded host-side editing. Experimental batch work can extend that value only if each note stays isolated in a fresh no-history turn, every draft is separately reviewed, and the final write set is confirmed again. Normal comparisons are exact; work-limit fallbacks are coarse but complete. The product must never imply that the separate agent process is OS-sandboxed, that multi-file writes are atomic, or that best-effort rollback is guaranteed recovery.

## Suggested model

Start with an MIT-licensed core and treat sponsorship as validation, not projected income:

- free plugin and reproducible builds;
- GitHub Sponsors or another transparent donation page after beta retention is demonstrated;
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
- [x] Initial reviewed commit on public-repo-ready history
- [x] First GitHub CI run green on Node 20, 22, and 24
- [x] Maintainer account and canonical repository confirmed: `Bum-Boo/agent-change-gate`
- [x] Repository publicly cloneable without authentication
- [x] Compatibility matrix publicly available with its initialize-only evidence level clearly labeled
- [x] GitHub private vulnerability reporting enabled
- [x] Secret scanning and push protection enabled
- [x] Extended CodeQL analysis green for JavaScript/TypeScript and GitHub Actions
- [ ] Maintainer security-alert notification delivery manually verified
- [ ] Trademark and domain clearance before paid brand spend
- [ ] Product screenshots and a 30–60 second demo
- [ ] Ten external beta users across Hermes plus at least one additional ACP implementation
- [ ] Independent security review of the built `main.js`
- [x] GitHub prerelease `0.2.0` published and release assets verified
- [ ] Obsidian Community Plugins submission PR opened
- [ ] Obsidian Community Plugins listing merged

## Unreleased 0.3.0 batch gate

- [x] Product boundary documented as experimental, opt-in, selected Markdown batch review rather than unattended vault automation
- [ ] Runtime and tests enforce the public hard limits of 20 files and 500,000 selected-scope characters
- [ ] One fresh ACP turn per selected note with no conversation history verified in the host flow
- [ ] Separate bounded diff review for every draft and a final batch confirmation verified in the host flow
- [ ] File creation, deletion, move, rename, and non-Markdown writes proven unreachable through the batch host path
- [ ] Automated integration tests prove no write begins when any approved target is stale
- [ ] Automated integration tests cover partial apply, interrupted-run reconciliation, and guarded best-effort rollback
- [ ] Manual Obsidian GUI test covers selection, cost/context preflight, stop, per-draft review, final confirmation, stale-all block, partial results, and recovery
- [ ] Real-model batch run verified against the exact supported Hermes version
- [ ] Batch run verified against at least one additional ACP implementation
- [ ] Privacy and recovery-state deletion controls verified in a packaged build
- [ ] Independent review of the multi-file write and recovery path
- [ ] GitHub prerelease `0.3.0` published and downloaded assets verified

Do not describe `0.3.0` as released, production-ready, transactional, or Community Plugins-distributed until the applicable gates above are complete.

## Post-beta monetization gate

- [ ] Retention evidence above has been collected from at least ten external beta users
- [ ] Real funding URL in `manifest.json`
- [ ] Matching `.github/FUNDING.yml`
- [ ] Funding disclosures and sponsor benefits are documented without gating safety fixes

## Early validation

Track only aggregate, manually reported outcomes; do not add telemetry by default.

- setup completion rate and time-to-first-response;
- first successful agent reply;
- first reviewed edit applied;
- edits discarded because the scope was wrong;
- stale edits correctly blocked;
- selected batch size and time to review all drafts;
- batch drafts approved versus rejected after review;
- partial or interrupted batches and whether guarded recovery completed without overwriting later user changes;
- weekly users who return to the same note thread;
- sponsor conversion after repeated use.

The first product decision should be based on whether users value the review-before-write flow enough to return, not on raw chat volume, stars, or launch-day downloads.
