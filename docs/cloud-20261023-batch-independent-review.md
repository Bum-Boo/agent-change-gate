# Vault Batch 독립 신뢰성 검토 (2026-10-23, 클라우드)

- 대상: PR #3, 브랜치 `codex/vault-batch-mode`, 정확한 head `4108176715dda2a3747e356ad5bb20654e878632` (`git rev-parse` 로 확인, `origin/main` 대비 4커밋)
- 범위: `src/core/batch.ts`, `src/core/batch-recovery.ts`, `src/core/batch-close.ts`, `src/main.ts`(apply/reconcile/undo), `src/ui/batch-modal.ts`(준비·생성·취소·검토·적용 콜백), 관련 ACP 취소 경로(`src/hermes/acp-client.ts`)
- 성격: 독립 검토. 제품 소스, 워크플로, 의존성, 매니페스트, 릴리스 게이트는 수정하지 않았음. `docs/BETA_TESTING.md` 의 미출시/베타 게이트는 그대로이며 이 문서는 릴리스 판단이 아님.
- 데이터: 전부 메모리 내 합성 노트. 실제 vault, 모델 호출, 자격 증명, GUI 자동화 없음.

## 결론 요약

| 구분 | 건수 | 내용 |
| --- | --- | --- |
| 검증된 결함 | 1 (낮음) | F1: 플러그인이 쓰지 않은 노트를 `recovery-required` 로 표시하고 전체 쓰기를 잠금 |
| 정적 위험 | 2 | S1: "열린 노트" 판정이 `markdown` leaf 만 봄 / S2: 저장 실패 시 메모리 journal 상태 표류 |
| 이미 보호됨 | 다수 | 아래 "확인된 보호 동작" |
| 데이터 손실·승인 재사용·본문 유출 | 0 | 재현 시도 범위 안에서 발견되지 않음 |

사용자 편집 손실, 상태 변경 후 승인 재사용, 수정본(replacement) 텍스트의 journal 유출은 재현되지 않았다.

## F1 (검증됨, 심각도 낮음): 쓰지 않은 노트가 recovery-required 로 잠김

- 위치: `src/main.ts:410-435` (실패 후 분류 루프), 특히 `427-430`; 이후 `478-490` 결과 매핑, undo 거부 `src/main.ts:767-771`
- 트리거: 배치 A, B, C 적용 중 A 쓰기 후 (동기화 도구·다른 앱 등으로) 아직 시도되지 않은 C 가 외부에서 바뀌고, B 쓰기가 I/O 오류로 실패. 또는 B 자체가 preflight 이후 외부에서 바뀌어 `vault.process` 콜백의 가드(`src/main.ts:379-381`)가 쓰기 전에 거부.
- 관찰: A 는 정확히 롤백되고 C/B 의 사용자 내용도 보존됨(데이터 손실 없음). 그러나 분류 루프가 "before 도 after 도 아님"을 모두 `conflict` 로 보아 C(또는 B)를 `recovery-required` 로 표시하고 phase 를 `recovery_required` 로 저장 → 모든 플러그인 쓰기(`runNoteMutation`, 새 배치)가 잠김. "Review and undo last vault batch" 도 C 가 after 가 아니라며 거부. 유일한 해제는 설정의 "Keep current files and unlock"(복구 증거 폐기).
- 기대: 플러그인이 `process()` 를 호출하지 않았거나 콜백이 쓰기 전에 throw 한 대상은 `not-applied`(또는 `stale`)로 보고하고, 플러그인이 쓴 파일이 모두 정확히 롤백되었다면 잠그지 않아야 함. 사용자는 "내 노트가 손상되었을 수 있다"는 잘못된 신호를 받는다.
- 재현: `review/batch-independent-review.harness.ts` 의 `F1` 두 테스트(현재 동작을 단언하므로 통과 = 재현).
- 최소 수정 방향: 쓰기 루프에서 `process()` 호출 직전 `attemptedPaths` 에 기록하고, 콜백이 반환값을 내기 전 throw 한 경우를 구분(`callbackReturned` 플래그). 분류 시 미시도 또는 콜백 거부 대상의 "neither" 상태는 `pending` → `not-applied` 로 처리하고 `recoveryRequired` 를 올리지 않음. 시도했지만 결과가 불명확한 대상만 `conflict`. 재시작 reconcile(`src/main.ts:686-708`)은 영속 상태만으로 구분이 불가능하므로 현재처럼 보수적으로 두어도 됨. 회귀 테스트는 위 하네스 시나리오를 `tests/main-batch.test.ts` 에 기대값으로 옮기면 됨.

## 정적 위험

### S1: 열린 편집기 판정이 `markdown` leaf 에 한정

- 위치: `src/main.ts:233-237` (`isBatchFileOpen`), 사용처 `239-244`, `372-378`, `451-460`, `731-733`, `792-800`; 선택 UI `src/ui/batch-modal.ts:375,434`
- 위험: `.md` 파일을 다른 view type 으로 여는 경우(예: Kanban 같은 서드파티 view, Canvas 내 파일 노드, 페이지 미리보기 hover 편집기)는 `getLeavesOfType("markdown")` 에 잡히지 않는다. 이런 view 가 자체 메모리 버퍼를 나중에 저장하면 배치 쓰기를 덮을 수 있다(이 경우 이후 rollback/undo 가 hash 불일치로 거부하므로 사용자 내용이 덮이지는 않지만, 배치 결과가 조용히 사라지거나 recovery 잠금이 생김).
- 확인 방법: 단위 테스트로는 Obsidian view 동작을 증명할 수 없어 수동 GUI 확인 필요(아래 표).
- 최소 수정 방향: 모든 leaf 를 순회하며 `leaf.view` 가 `file?.path === notePath` 를 가진 FileView 이면 열린 것으로 간주(유형 무관, fail-closed). hover 편집기는 별도 확인.

### S2: 저장 실패 시 메모리 journal 상태 표류 (데이터 손실 없음)

- 위치: `src/main.ts:775-777` (undo 의 `rolling_back` 저장이 throw 하면 메모리 phase 만 `rolling_back` 으로 남아 세션 동안 잠김; 디스크는 `completed`), `src/main.ts:807-813` (복원 성공 후 `saveState` 실패 시 실제로는 복원된 항목을 `conflict` 로 표시하고 나머지 undo 중단).
- 영향: 과잉 잠금·라벨 오류뿐이며, 다음 undo 또는 재시작 reconcile 이 hash 로 다시 분류하므로 덮어쓰기는 없음.
- 최소 수정 방향: phase 변경을 저장 성공 후에 메모리에 반영(또는 실패 시 이전 phase 복원), 쓰기 성공과 저장 실패를 별도 상태로 보고.

## 확인된 보호 동작 (재현 시도 → 안전)

- 모델 turn 대기 중 취소/stale 설정: `activeRequest` 설정과 `acpPool.prompt` 의 `activeTurns` 등록이 동기 구간에서 연속(`src/ui/batch-modal.ts:729-730`, `src/hermes/acp-client.ts:344-360`). 직전 `vaultBatchTurnBlockReason`(`batch-modal.ts:708-728`)이 run token·취소·닫힘·recovery 잠금·agent context 를 재확인하고, `runPrompt` 는 각 await 경계에서 `cancelRequested` 확인(`acp-client.ts:399-424`), 응답 후 `isCurrentBatchRun` 재확인(`batch-modal.ts:749`)으로 취소된 turn 의 결과는 버려짐. 설정 변경은 준비 전후·확인 후 `sameVaultBatchSetup` 로 거부(`batch-modal.ts:513-532`), 생성 중에는 설정 UI 자체가 사라짐.
- preflight 와 쓰기 사이 대상 변경: 쓰기 콜백 내부에서 `current === snapshot.fullText` 와 열린 상태를 재확인(`main.ts:375-383`). 하네스에서 A 쓰기 직후 B 를 열거나 바꾸면 B 는 쓰이지 않고 A 는 롤백됨.
- 상태 변경 후 승인 재사용: apply 는 agent context(`main.ts:257-261`), 호스트 바인딩 재검증(`268-287`), 전체 대상 exact preflight(`289-316`)를 다시 수행. 승인은 스냅샷 원문과 정확히 일치할 때만 유효.
- 부분 쓰기 후 재시작: prepared/applying journal 이 첫 쓰기 전에 저장됨(하네스 "prepared journal is persisted"). A 쓰기 직후 크래시를 모사한 영속 상태로 재시작하면 reconcile 이 hash 로 A=`written`, B=`rolled_back` 판정 후 잠그고, undo 가 A 만 정확히 복원하고 잠금 해제. A 가 그 사이 사용자에 의해 바뀌었으면 undo 는 쓰기 0 회로 거부하고 잠금 유지.
- rollback/undo 의 동시 편집: 자동 rollback 과 undo 모두 콜백 안에서 `afterFullHash` 일치와 재구성 hash 를 확인(`batch-recovery.ts:219-246`, `main.ts:457-464,797-806`). 사용자 편집은 덮이지 않음. undo 는 쓰기 전에 모든 대상을 먼저 검증하여 하나라도 diverge 하면 쓰기 0 회.
- journal 개인정보: journal 은 경로, scope 범위, 원래 scope 평문, before/after 전체 hash 만 보관. 하네스에서 replacement 텍스트와 scope 밖(frontmatter) 텍스트가 `data.json` 직렬화에 없음을 확인. 원래 scope 평문 보관은 rollback 에 필수이며 `PRIVACY.md` 32-43행에 명시되어 있어 결함이 아님(다만 Obsidian Sync 등으로 `data.json` 이 복사될 수 있다는 점도 그곳에 공지됨). 오류·Notice 문자열은 경로와 진단 코드만 포함하고 본문·절대경로를 포함하지 않음(`main.ts:296-301` 기존 테스트 포함).

## 비결함 메모

- 거부했던 초안을 적용 후 다시 승인해 같은 `batchId` 로 두 번째 적용을 하면 이전 완료 배치의 undo journal 이 대체된다. 최종 확인 문구(`batch-modal.ts:971`)가 이를 알리므로 결함으로 보지 않음.
- `afterText = applyReplacement(snapshot, effectiveReplacement)`(`batch-modal.ts:775-776`)는 구분자 보정을 두 번 적용하지만 `replacementForSnapshot` 이 `\n`/`\r` 시작 문자열에 대해 멱등이라 `from + afterScopeLength` 재구성과 일치함.

## 남은 수동 GUI 확인 (격리된 일회용 vault, 패키지 빌드)

1. S1: Kanban 등 비-markdown view, Canvas 파일 노드, hover 편집기로 대상 노트를 연 상태에서 배치 적용 → 대상이 거부되는지.
2. F1 수정 전후: 적용 중 외부 앱으로 미시도 대상을 수정 → 결과 라벨과 잠금 여부.
3. 생성 중 Stop / 닫기 → 이후 어떤 초안도 적용 불가, 실제 Hermes turn 취소 수신 여부.
4. `BETA_TESTING.md` 수동 배치 매트릭스 1-10 항목은 여전히 `Not run`; 이 검토는 그 어떤 항목도 Pass 로 대체하지 않음.

## 검증 명령

```bash
git fetch origin codex/vault-batch-mode && git rev-parse FETCH_HEAD   # 4108176715dda2a3747e356ad5bb20654e878632
npm ci
npm run check                                            # 기존 20 파일 / 162 테스트 통과 (이 VM, Node 22.22.0)
npx vitest run --config review/vitest.config.mjs         # 검토 하네스 9 테스트 통과 (F1 재현 2 + 보호 확인 7)
```

하네스는 `review/` 아래 별도 vitest 설정으로만 실행되며 기본 `npm test` include 와 `tsconfig.json` include 에 들어가지 않으므로 PR 의 CI 결과를 바꾸지 않는다.
