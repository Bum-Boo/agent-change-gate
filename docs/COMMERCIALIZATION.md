# Commercialization plan

Current verdict: viable as a focused open-source product, not yet proven as a donation business. Do not spend on branding, ads, or paid infrastructure until external retention is demonstrated.

Current evidence as of 2026-08-13 is intentionally narrow: one isolated Windows + WSL Hermes Lab Ask passed, followed by one edit proposal that reached a complete diff and was explicitly applied. The batch GUI, real-model batch turns, rollback, and recovery remain manually unverified. `0.3.0` is unreleased, the project is not listed in Obsidian Community Plugins, and funding remains disabled.

## Positioning

Lead with one promise:

> Let AI propose. You decide what changes.

Explain it with one category statement:

> Agent Change Gate is change control for AI-edited notes: selected scope in, complete draft diff out, explicit approval before this plugin writes.

Hermes is the first-class setup path, not the whole category. The defensible value is the combination of a proposal-only host contract, exact scope snapshots, bounded complete diffs, stale-response protection, scope receipts, and guarded host-side editing. Experimental batch work can extend that value only if each note stays isolated in a fresh no-history turn, every draft is separately reviewed, and the final write set is confirmed again. Normal comparisons are exact; work-limit fallbacks are coarse but complete. The product must never imply that the separate agent process is OS-sandboxed, that multi-file writes are atomic, or that best-effort rollback is guaranteed recovery.

## Suggested model

Start with an MIT-licensed core and treat sponsorship as validation, not projected income:

- free plugin and reproducible builds;
- GitHub Sponsors or another transparent donation page after beta retention is demonstrated;
- sponsor recognition, transparent roadmap input, and optional early builds;
- no safety fixes, privacy controls, or basic agent support behind a paywall.

If sustained demand appears, the more credible paid path is separate and clearly optional: managed team policy packs, signed enterprise deployment, compatibility support, or audited organization presets. Do not turn note privacy or security fixes into an upsell.

## Evidence gate before monetization work

Run the four-week, 30-person funnel in [BETA_TESTING.md](BETA_TESTING.md). Continue investing only if:

- at least 20 qualified recruits install the checked beta;
- at least 15 activate without live help by completing Ask plus a reviewed edit;
- at least eight return in week two and five return in week four;
- at least three users say the review gate, not generic chat, is the reason they would keep it;
- every intentionally stale proposal is refused;
- no high-severity boundary or data-loss issue remains open;
- batch metrics are reported only if the manual Lab batch and recovery gate passed first.

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
- [x] Compatibility matrix publicly available with its exact single-note Lab smoke evidence clearly labeled
- [x] GitHub private vulnerability reporting enabled
- [x] Secret scanning and push protection enabled
- [x] Extended CodeQL analysis green for JavaScript/TypeScript and GitHub Actions
- [ ] Maintainer security-alert notification delivery manually verified
- [ ] Trademark and domain clearance before paid brand spend
- [x] Three isolated-Lab screenshots for Ask, complete diff, and reviewed apply
- [ ] A 30–60 second demo that does not imply batch/recovery verification
- [ ] Four-week external beta: 30 recruits, 20 installs, 15 activations, eight week-two and five week-four returners
- [ ] At least one external tester on an ACP implementation other than the maintainer-verified Hermes setup
- [ ] Independent security review of the built `main.js`
- [x] GitHub prerelease `0.2.0` published and release assets verified
- [ ] Obsidian Community Plugins submission PR opened
- [ ] Obsidian Community Plugins listing merged

## Unreleased 0.3.0 batch gate

- [x] Product boundary documented as experimental, opt-in, selected Markdown batch review rather than unattended vault automation
- [x] Runtime and tests enforce the public hard limits of 20 files and 500,000 selected-scope characters
- [ ] One fresh ACP turn per selected note with no conversation history verified in the host flow
- [ ] Separate bounded diff review for every draft and a final batch confirmation verified in the host flow
- [ ] File creation, deletion, move, rename, and non-Markdown writes proven unreachable through the batch host path
- [x] Automated host integration test proves no write begins when any approved target is stale
- [x] Automated host integration tests cover an injected later-write failure and guarded best-effort rollback
- [ ] Packaged restart test covers interrupted-run reconciliation and guarded recovery review
- [ ] Manual Obsidian GUI test covers selection, cost/context preflight, stop, per-draft review, final confirmation, stale-all block, partial results, and recovery
- [ ] Real-model batch run verified against the exact supported Hermes version
- [ ] Batch run verified against at least one additional ACP implementation
- [ ] Privacy and recovery-state deletion controls verified in a packaged build
- [x] Independent source review found no remaining P0/P1 issue in the current multi-file write and recovery path; GUI and packaged-runtime evidence remain separate open gates
- [ ] GitHub prerelease `0.3.0` published and downloaded assets verified

Do not describe `0.3.0` as released, production-ready, transactional, or Community Plugins-distributed until the applicable gates above are complete.

## Post-beta monetization gate

- [ ] The 30-person beta funnel met its 20-install, 15-activation, eight-week-two, five-week-four, and three-review-gate-value thresholds
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
