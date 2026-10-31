# 대기 중인 의존성 업데이트 통합 검증 (2026-10-31)

브랜치 `claude/verify-dependency-updates-qztbfl`(기준: `main` 1c2860b)에 Dependabot PR #7, #13, #14, #16, #17, #18, #19, #20을 함께 적용했다. 그 상태로 설치, 타입 검사, 단위 테스트, ACP 테스트, 빌드, 릴리스 검증, `npm audit`을 Node 20.20.2 / 22.23.4 / 24.22.1에서 모두 실행했다. PR #3은 건드리지 않았다.

## 결론: 업데이트별 판정

| PR | 변경 | 단독 | 함께 | 비고 |
| --- | --- | --- | --- | --- |
| #16 | actions/setup-node 7.0.0 → 7.1.0 | 안전 | 안전 | 핀 SHA `949feb2…`가 upstream 태그 v7.1.0과 일치한다(`git ls-remote`로 확인). Actions 실행 자체는 이 VM에서 검증하지 못했다. |
| #19 | source-map-js 1.2.1 → 1.2.2 | 안전 | 안전 | high 권고 GHSA-68fv-2mgg-jv7q를 해소한다. |
| #20 | vite 8.2.1 → 8.3.4 | 안전 | 안전 | vite high 권고 6건을 해소한다. #14와 lockfile이 충돌한다(아래 참조). |
| #18 | @agentclientprotocol/sdk 1.3.0 → 1.7.0 | 안전* | 안전 | 프로토콜 버전과 권한 스키마는 그대로다. *PR 상태 그대로는 provenance 문서가 1.3.0으로 남는다(검증된 결함 D2, 이 브랜치에서 수정). |
| #17 | obsidian 1.13.1 → 1.14.4 | 안전 | 안전 | moment moderate 권고를 해소한다. 타입 검사를 통과한다. |
| #13 | @types/node 24.13.3 → 24.19.1 | 안전 | 안전 | — |
| #14 | vitest 4.1.10 → 5.0.3 | 안전(조건부) | 안전(조건부) | 코드 수정은 필요 없었다. vitest 5의 `engines`는 Node 20을 지원하지 않는다(위험 R1). |
| #7 | vitest/@vitest/mocker 4.1.10 → 4.1.11 | 안전 | **대체됨** | #14가 대체한다. 4.1.11에도 @vitest/mocker 권고(`<=4.1.11`)가 남아 있다. #14를 채택하면 닫아도 된다. |

이 8개를 모두 합쳐도 CI의 `npm audit --audit-level=high`는 **여전히 실패한다**. 원인은 목록에 없는 zod `<4.6.6` 권고다(D1). 이 브리프의 범위 밖이라 zod는 올리지 않았다.

## 발견 사항

### D1. 검증된 결함: 모든 PR의 CI가 audit 단계에서 실패하고, Node 20/24 잡은 실제로 실행되지 않는다
- 위치: `.github/workflows/ci.yml:31`(`npm audit --audit-level=high`), 매트릭스는 `.github/workflows/ci.yml:20`.
- `main`(1c2860b)에서 이미 high 권고가 남아 있다. vite 8.2.0–8.2.2, source-map-js 1.0.0–1.2.1에 더해 이후 zod `<4.6.6`(GHSA-mrhx-c7xc-m3w5)이 새로 생겼다.
- PR #18 CI 로그(job 114618925023, Node 22)가 audit 단계에서 exit 1로 끝났다. 기본 fail-fast 때문에 Node 20/24 잡은 `cancelled`로 끝났다.
- 각 PR 단독으로는 다른 권고가 남아서 하나도 audit을 통과하지 못한다. #19와 #20을 함께 넣어야 vite와 source-map-js가 해소된다.
- 이 브랜치에서 남는 것은 zod 하나뿐이다(`npm audit` 결과 "1 high severity vulnerability").
- zod는 SDK를 통해 `main.js`에 번들되는 런타임 의존성이다. 그래서 다음 단계에 zod 갱신과 함께 문서 갱신도 포함해야 한다.

### D2. 검증된 결함: SDK와 개발 의존성을 올려도 provenance 문서가 이전 버전으로 남고, 릴리스 검증이 이를 잡지 못한다
- `docs/OPEN_SOURCE.md:9`는 SDK를 `1.3.0`으로, `:18`, `:21`, `:22`는 obsidian/vitest/@types/node를 이전 버전으로 적고 있었다. `THIRD_PARTY_NOTICES.md:5`도 SDK를 `1.3.0`으로 적고 있었다.
- CONTRIBUTING의 "Dependency and source provenance"는 이 문서들의 갱신을 요구한다.
- 재현: 업그레이드 후 `npm run validate:release`가 그대로 통과했다(버전을 검사하지 않음).
- 수정:
  - `scripts/validate-release.mjs:13`, `:56-76`에서 문서의 버전을 `package-lock.json`의 잠긴 버전과 비교하도록 했다.
  - 문서를 갱신하기 전에 이 검사를 돌려 `docs/OPEN_SOURCE.md does not record the locked @agentclientprotocol/sdk 1.7.0.`로 실패하는 것을 확인했다.
  - `main` 상태에서는 같은 검사가 통과하는 것도 확인했다.
  - 이후 문서를 갱신했다. 앞으로 zod를 올릴 때도 이 검사가 문서 갱신을 강제한다.

### R1. 정적 위험: vitest 5.0.3은 Node 20을 지원 대상에서 뺐다
- vitest 5.0.3의 `engines.node`는 `^22.12.0 || ^24.0.0 || >=26.0.0`다.
- 그런데 이 저장소는 `package.json:47`(`>=20`), `CONTRIBUTING.md:5`, `ci.yml:20`에서 여전히 Node 20을 지원한다고 적고 있다.
- Node 20.20.2에서 `npm ci`는 `EBADENGINE` 경고만 내고 성공한다. 테스트 94개도 모두 통과한다.
- 다만 upstream이 보장하지 않으므로 이후 패치 릴리스에서 깨질 수 있다. Node 20은 2026-04-30에 EOL이다.

### R2. 정적 위험: SDK 1.7.0은 1.3.0이 버리던 세션 업데이트를 이제 앱으로 전달한다
- SDK 1.7.0은 `notice`, `session_message_chunk`, `compaction_summary_chunk`, `subagent_update` 같은 새 `SessionUpdate` 변형을 검증한 뒤 `nextUpdate()`로 넘긴다.
- 1.3.0은 이것들을 파싱 실패로 처리해 버렸다.
- 앱은 `agent_message_chunk` 텍스트만 제안에 넣는다(`src/hermes/acp-client.ts:568-580`). 나머지는 보조 업데이트 한도 4096(`ACP_MAX_TURN_AUX_UPDATES`)에 계산된다.
- 그래서 사양을 어기고 이런 업데이트를 4096개 넘게 보내는 에이전트는 이제 `AcpTurnOutputLimitError`로 턴이 실패한다. 이는 fail-closed다.
- 클라이언트가 `clientCapabilities: {}`만 광고하므로, 사양을 지키는 에이전트는 이런 업데이트를 보내면 안 된다.
- 동작 차이 확인: 새 테스트 `tests/acp-transport.test.ts:638`은 1.7.0에서 통과하고, SDK를 1.3.0으로 내린 임시 worktree에서는 실패했다.

### R3. 정적 위험: ACP 테스트 시간 제한(이전의 30s 요구)
- vitest 5의 기본 `testTimeout`도 5s다. 저장소 기록(`git log -S30_000`)에는 테스트에 30s 시간 제한을 준 흔적이 없다.
- 이 VM에서 CPU 4코어에 바쁜 루프 8개를 띄워 부하를 줬다. 그래도 가장 느린 ACP 테스트가 0.93s였다(`npx vitest run tests/acp-transport.test.ts --reporter=verbose`). 재현하지 못했으므로 시간 제한은 바꾸지 않았다.
- 다만 `timeoutMs: 10_000`을 쓰는 테스트(`tests/acp-transport.test.ts:474`, `:506`, `:646`)는 내부 시간 제한이 테스트 기본값 5s보다 길다.
- 그래서 Windows/WSL처럼 프로세스 생성이 느린 환경에서는 의도한 오류보다 vitest 시간 초과가 먼저 날 수 있다.

### R4. 정적 위험: obsidian 타입 1.14.4와 `minAppVersion` 1.13.4의 차이
- 타입에는 1.14 API가 들어 있지만 `manifest.json`의 `minAppVersion`은 1.13.4다. 지금 코드는 1.14 전용 API를 쓰지 않는다.
- 1.14.4에서 새로 deprecated된 `close()`는 `Menu`의 것이다. `src/ui/diff-modal.ts:197`, `src/ui/confirm-modal.ts:46`이 호출하는 `Modal.close()`와는 무관하다.

### C1. 이미 보장됨(이번에 테스트로 고정): 승인 게이트 동작
- 기존 테스트에는 권한 거부, fs/terminal 거부, 빈 capability를 직접 검증하는 테스트가 없었다.
- 그래서 업그레이드 **전에** SDK 1.3.0에서 테스트를 추가했다(커밋 8b97885). 업그레이드 후에도 같은 결과가 나온다.
- 추가한 테스트(`tests/acp-transport.test.ts:656-802`):
  - `clientCapabilities`가 `{}`이다.
  - 권한 요청에는 `reject_always`, 없으면 `reject_once`를 고르고, 거부 옵션이 없으면 `cancelled`로 답한다.
  - 사용자가 취소한 뒤 도착한 권한 요청은 `cancelled`로 답한다.
  - fs 2종과 terminal 5종 요청은 모두 `-32601`이다.
  - SDK 1.7.0을 반영해 추가: `elicitation/create`, `elicitation/complete`, `mcp/message`, 확장 메서드도 `-32601`이다.
- 변형 검증으로 테스트가 실제로 결함을 잡는지 확인했다. 각 변형 적용 시 해당 테스트가 실패했다.
  - allow 옵션을 고르게 바꿈
  - fs capability를 광고하게 바꿈
  - fs/terminal 핸들러가 결과를 돌려주게 바꿈
  - 취소된 세션 검사를 제거함
- 핸들러를 *삭제*하는 변형으로는 실패하지 않는다. SDK가 등록되지 않은 요청에 기본으로 `methodNotFound`를 돌려주기 때문이다(1.7.0 `dist/jsonrpc.js:774-775`).
- `tests/acp-transport.test.ts:621`은 `session_message_chunk`나 compaction 텍스트가 제안 텍스트에 섞이지 않음을 고정한다.

### N1. 문제 아님: SDK 1.3.0 → 1.7.0 API와 번들
- `PROTOCOL_VERSION`은 1로 같다. `methods.client`, 권한 옵션 종류와 outcome 스키마, `buildSession`/`ActiveSession`/`session/close`도 그대로다.
- 앱은 자체 `boundedAcpNdJsonStream`을 쓰므로, SDK의 새 32 MiB 프레임 제한과 파싱 오류 처리 변경의 영향은 `scripts/smoke-acp.mjs`에만 미친다.
- `LICENSE`(Apache-2.0)는 바이트 단위로 같다. 테스트 픽스처 `dist/examples/agent.js`도 같다.
- 프로덕션 `main.js`는 471,989 → 473,905 bytes다. `require()` 대상은 `node:child_process`, `node:crypto`, `node:os`, `node:path`, `node:stream`, `obsidian`으로 변화가 없다. HTTP/WS 서버 코드는 번들에 들어오지 않았다.

## 변경한 내용(커밋 순)

1. `8b97885` test: SDK 1.3.0 기준 승인 게이트 테스트 4개
2. `5bc394d`…`e2f3604`: #16, #19, #20, #18, #17, #13을 Dependabot 변경 그대로 적용했다(`cherry-pick -n`, 각각 별도 커밋).
3. `35d995c` vitest 5.0.3(#14, #7 대체)
   - #20 이후 lockfile이 충돌했다. Node 22의 npm 10.9.x는 `Cannot read properties of null (reading 'edgesOut')`로 해석에 실패했고, npm 11.19.1(Node 24)로 다시 생성했다.
   - npm이 vite를 8.3.5로, rolldown/postcss/chai도 함께 올렸다. 그래서 의존 범위를 만족하는 한 기존 잠금 버전으로 되돌렸다. 그 결과 vite는 8.3.4다.
   - 최종 lockfile 차이는 vitest 5와 그것이 요구하는 패키지(@vitest/*, tinybench, magic-string, es-module-lexer, why-is-node-running, @jridgewell/*)뿐이다. `npm ls --all`은 exit 0이다.
4. `0be1d55` docs/script: provenance 버전 갱신과 `validate-release` 버전 검사(D2)
5. `429d38e` test: SDK 1.7 세션 업데이트 변형 2개와 미등록 요청 1개 테스트

제품 코드(`src/`)는 바꿀 필요가 없었다.

## 실행한 명령과 결과

각 Node 버전에서 worktree마다 `npm ci → npm audit --audit-level=high → npm run typecheck → npx vitest run → npm run build → npm run validate:release` 순서로 실행했다.

| 대상 | Node | ci | audit(high) | typecheck | tests | build | validate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `main` 1c2860b (이전) | 20/22/24 | 통과 | **실패** | 통과 | 87/87 | 통과 | 통과 |
| 각 Dependabot 브랜치 단독(8개) | 20/22/24 | 통과(#14는 Node 20에서 EBADENGINE 경고) | **실패**(남은 권고는 D1 참조) | 통과 | 87/87 | 통과 | 통과 |
| 이 브랜치 (이후) | 20/22/24 | 통과(Node 20에서 vitest EBADENGINE 경고) | **실패**(zod만 남음) | 통과 | 94/94 | 통과 | 통과 |

추가로 실행한 것:
- `npx vitest run`을 5회 반복했다. 매번 91/91(SDK 1.3.0, 게이트 테스트 추가 후)이었고 불안정한 테스트는 없었다.
- `HERMES_PROFILE=synthetic HERMES_EXECUTABLE=<SDK 예제 에이전트를 실행하는 가짜 스크립트> npm run smoke:acp`의 결과는 `{"ok":true,"protocolVersion":1,…}`였다.
- 업데이트별 `npm audit --package-lock-only` 결과:
  - #19 단독: vite와 zod high가 남는다.
  - #20 단독: zod high가 남는다.
  - #7 단독: @vitest/mocker moderate가 남는다.

## 이 VM에서 검증하지 못한 것

- Windows, macOS, WSL 실행과 Windows에서의 ACP 테스트 소요 시간(R3)
- 실제 Obsidian 데스크톱 GUI(1.13.4 / 1.14.x)에 플러그인을 로드하는 것
- 실제 Hermes Agent 등 외부 ACP 에이전트. 모든 테스트는 합성 가짜 에이전트만 사용했다.
- GitHub Actions에서 setup-node 7.1.0이 실제로 실행되는지

## 소유자를 위한 다음 단계

1. zod를 4.6.6 이상으로 올린다(`npm update zod` 후 lockfile 확인). 그리고 `docs/OPEN_SOURCE.md:10`과 `THIRD_PARTY_NOTICES.md:6`을 갱신한다. 새 `validate:release`가 누락을 잡아 준다. 이것이 CI audit을 녹색으로 만드는 마지막 조건이다.
2. Node 20을 결정한다.
   - (a) vitest 5를 채택하고 `ci.yml:20`, `package.json:47`, `CONTRIBUTING.md:5`에서 Node 20을 뺀다.
   - (b) Node 20을 유지하고 vitest를 4.1.12 이상의 4.x로 둔다. 이 경우 `.github/dependabot.yml`에 vitest major ignore를 추가한다.
3. 이 브랜치를 채택하면 #7, #13, #14, #16, #17, #18, #19, #20은 중복이 된다. #14와 #20은 개별 병합 시 lockfile이 충돌한다.
4. Windows에서 `npx vitest run tests/acp-transport.test.ts --reporter=verbose`로 소요 시간을 잰다. 5s에 가까우면 `ACP pool compatibility` describe에 `{ timeout: 30_000 }`을 준다.
5. CI 매트릭스에 `fail-fast: false`를 검토한다. 지금은 한 Node 버전이 실패하면 나머지 결과를 볼 수 없다.
