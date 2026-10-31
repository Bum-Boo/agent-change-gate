# 승인 게이트 독립 리뷰 (2026-10-31)

대상: `main` @ `1c2860b` (읽기 전용 리뷰). 프로덕션 소스·워크플로·의존성·매니페스트·릴리스 규칙은 수정하지 않음. 추가물은 이 문서와 `review/gate-review.test.ts`(합성 데이터 재현 테스트 12건)뿐.
편집기 대체물로 `node_modules`에 이미 있는 `@codemirror/state` 6.5.0(`obsidian`의 전이 의존성)을 사용. Obsidian은 CM6 문서를 쓰지만 실제 GUI·Hermes·네트워크는 실행하지 않음.

## 추적한 코드 경로
- 노트 쓰기 경로는 두 곳뿐: 편집 적용 `src/ui/chat-view.ts:541` (`replaceRange`), 되돌리기 `src/main.ts:228` (`setValue`). 그 외 `vault.modify`/`adapter.write` 없음. ACP fs/terminal 요청은 `src/hermes/acp-client.ts:680-686`에서 거부, `clientCapabilities: {}`(701).
- 승인: `DiffModal`은 **Apply** 클릭에서만 `true`, 닫기/Discard는 `false`(`src/ui/diff-modal.ts:103-110,188-198`). 잘린 diff·변경 없음이면 Apply 비활성(106). Ask 작업에서 `propose_edit`는 파싱 단계 거부(`src/core/protocol.ts:111`).
- 오래된 승인: 적용 직전 경로+전체 내용 일치 확인을 큐 안에서 두 번(`chat-view.ts:502`, `529`), 사이에는 동기 `replaceRange`만 있음. 해시 외에 문자열 동일성도 비교(`scope.ts:132`)하므로 외톨이 서로게이트로 인한 UTF-8 해시 충돌도 막힘.

## 결과 요약
| # | 분류 | 심각도 | 요약 |
|---|---|---|---|
| F1 | 정적 위험 (CM6 모델로 재현) | P2 | 제안 안의 CR/CRLF가 diff에는 그대로 표시되지만 편집기 적용 시 LF로 정규화 → 표시≠적용, 되돌리기 체크포인트 무효 |
| F2 | 검증된 결함 (main) | P2 | 서로게이트 쌍 중간 선택 경계 허용 → 이모지 손상. NaN/소수 오프셋 허용. 수정은 미병합 브랜치에만 존재 |
| F3 | 정적 위험 | P3 | NFC↔NFD 전용 변경에 경고·마커 없음 (diff상 같은 글자로 보이는 −/+ 줄) |
| — | 이미 보장됨 | — | 승인 없는 쓰기 없음, 범위 밖 바이트 불변, 오래된 승인 거부, 프론트매터 탈출 차단, 한글 NFC/NFD 바이트 보존 |

### F1. CR/CRLF 제안: 표시한 diff ≠ 적용 결과, 되돌리기 상실 (P2, 정적 위험)
- 근거: `src/core/safety.ts:6` 금지 제어문자에서 `\r`(U+000D) 제외 → 통과. `diff-modal.ts:173-185`는 줄마다 `CRLF`/`CR`로 표시. `chat-view.ts:506`은 체크포인트 `after`를 문자열 결합으로 계산하지만, `chat-view.ts:541` `replaceRange`는 CM6가 `/\r\n?|\n/`로 줄을 나눠 LF만 저장.
- 트리거 → 관측 → 기대: 에이전트(예: Windows 쪽)가 `"# 제목\r\n고친 줄\r\n…"` 제안 → diff는 모든 줄을 CRLF 추가로 보여주고, 적용 후 노트는 LF, `checkpoint.after`와 불일치 → `src/main.ts:210`이 "The note changed after the saved edit"로 되돌리기 거부(적용 직후 "Use Review and undo" 안내와 모순) → 기대: 검토한 바이트가 그대로 저장되거나, 정규화가 diff에 반영되고 체크포인트가 실제 결과와 일치.
- 재현: `review/gate-review.test.ts` "REPRO F1" 2건(CRLF, 단독 CR). 실제 Obsidian `Editor.replaceRange`/`getValue`로는 미검증.
- 최소 수정 방향: `replacementForSnapshot`에서 `\r\n?`→`\n` 정규화 후 diff·적용에 같은 값 사용(또는 `\r` 차단), 그리고 체크포인트 `after`를 적용 후 `editor.getValue()`로 기록하거나 불일치 시 체크포인트 폐기.

### F2. 선택 경계가 서로게이트 쌍을 가름 (P2, main에서 검증된 결함)
- 근거: `src/core/scope.ts:55-63`은 정수·서로게이트 경계를 확인하지 않음.
- 트리거 → 관측 → 기대: `"앞😀뒤"`에서 `from`=저위 서로게이트 위치로 선택 → `originalScope="\uDE00뒤"`, 적용 결과 `"앞\uD83DX"`, UTF-8 저장 시 `앞�X`(이모지 손상) → 기대: 캡처 단계 거부. `{from: NaN}`은 예외 없이 통과, `{1.5, 3.5}`는 소수 좌표 저장.
- 참고: diff에는 `⟦U+DE00 LONE SURROGATE⟧`가 보이므로 승인 없이 손상되지는 않음. CM6 일반 커서는 쌍을 가르지 않아 GUI 발생 빈도는 낮을 것으로 추정(미검증).
- 수정 상태: 원격 `claude/task-r4k37t`(커밋 `b55bb3d`, `ef51aec`, `docs/cloud-20261023-scope-unicode.md`)에 수정·회귀 테스트가 있으나 **main 미병합**. 해당 브랜치 리뷰 후 병합 권장.

### F3. NFC↔NFD 전용 변경 무신호 (P3, 정적 위험)
- 근거: `safety.ts:55` 경고는 Default_Ignorable/특수 공백만 대상, `src/core/review-text.ts`는 결합 자모(U+1100–11FF)를 표시하지 않음.
- 트리거 → 관측 → 기대: 에이전트가 `"한글 노트"`를 NFD로 바꿔 제안 → 오류·경고 0, diff는 화면상 동일한 −/+ 줄 → 기대: "정규화만 다름" 경고(`replacement.normalize("NFC") === original.normalize("NFC") && replacement !== original`). 검색·링크·동기화에서 파일명/본문 불일치를 낳을 수 있음.
- 재현: "REPRO F3".

## 이미 보장됨 (재현 테스트로 확인)
- 본문/프론트매터/선택(NFC·NFD 한글, 반각 가나 포함) 적용 시 범위 앞뒤 바이트가 `Buffer` 비교로 동일, diff에서 재구성한 텍스트 = 실제 삽입 텍스트.
- 오래된 승인: NFC→NFD 변환, 경로 변경, 1글자 변경 모두 거부. 첫 승인 적용 후 같은 스냅샷의 두 번째 승인은 `stale`로 노트 불변.
- 프론트매터 제안 뒤 본문 텍스트 동반·개행 누락은 차단.
- `replacementForSnapshot`이 `chat-view.ts:430,506,537`에서 최대 3회 중첩 호출되지만 멱등(LF/CRLF/EOF 프론트매터)이라 이중 구분자 삽입 없음.
- 되돌리기 diff 한도: 체크포인트 상한(`state.ts:20-22`, 60만 자·4,000줄)이 되돌리기 diff 한도(4,000줄, 60만 자)와 같아 저장된 체크포인트는 항상 렌더 가능.

## 비이슈 / 범위 밖
- 다른 노트로 포커스를 옮긴 뒤 승인하면 대상 노트가 그대로여도 거부(`getActiveMarkdownView` 기반) — 실패 시 닫힘 방향의 UX 제약이며 결함 아님.
- 선택 범위가 0에서 시작하는 경우 프론트매터 도입 경고가 없음(`safety.ts` 본문 스코프만 경고) — 사용자가 고른 범위 안의 변경이며 diff에 보임.

## 실행 명령과 결과
```bash
git checkout -B claude/agent-change-gate-review-s3htfl origin/main   # main 1c2860b 기준
npm ci
npx vitest run                      # 리뷰 테스트 추가 전: 15 파일, 87 통과, 0 실패
npx vitest run review/              # 1 파일, 12 통과
npm run check                       # typecheck 통과, 16 파일 99 통과, build 성공, "Release metadata valid for agent-change-gate 0.2.0."
npx tsc --noEmit --strict --noUncheckedIndexedAccess --module esnext --moduleResolution bundler \
  --target es2022 --skipLibCheck --types node,vitest/globals review/gate-review.test.ts   # 오류 없음
```
Node v22.23.4. `review/` 테스트는 결함의 **현재 동작**을 단언하므로 수정이 들어가면 해당 REPRO 케이스가 실패하며, 그때 기대 동작으로 뒤집으면 회귀 테스트가 됨. `tsconfig.json`의 `include`에 `review/`가 없어 `npm run typecheck` 대상은 아님(위 별도 명령으로 확인).

## 미검증
Obsidian GUI, 실제 `Editor`의 CRLF/정규화 동작, Hermes/모델 응답, Windows/WSL 전송은 클라우드 VM에서 실행하지 않음.
