# 한글/유니코드 노트 편집 정확성 검증 (2026-10-23)

범위: `src/core/scope.ts`, `safety.ts`, `diff.ts`, `review-text.ts`. PR #3(vault batch), 의존성 PR, UI, 권한/승인 정책, 배치 모드는 건드리지 않음. 실제 vault·비밀값·유료 API 미사용.

## 결과 요약
- 실제 계약 위반 **1건(두 갈래)** 재현 후 `scope.ts`만 수정. `safety.ts`, `diff.ts`, `review-text.ts`는 결함 없음(수정 없음).
- 신규 테스트 `tests/unicode-scope.test.ts` (154 케이스, 외부 의존성·무작위 대량 생성 없음. 고정 시드 150회 diff 재구성 포함).

## 수정 전 재현된 위반 (프로브 실행 결과)
1. **NaN/소수 선택 오프셋 허용**: `resolveScopeRange(..., {from: NaN, to: 3})` → `{from: NaN, to: NaN}` 반환(오류 없음). `{from: 1.5, to: 3.5}` → 스냅샷에 `from=1.5, to=3.5` 저장, `originalScope`는 `"--"`(암묵적 절삭)로 캡처됨. 캡처된 범위와 저장된 좌표가 불일치.
2. **서로게이트 쌍 중간 선택**: 이모지(😀) 중간에서 시작/끝나는 선택이 허용되어 `originalScope="\ude00끝"`이 되고, 교체 결과가 `…본문\ud83dX`처럼 보존되어야 할 prefix에 외톨이 서로게이트가 남음 → 저장 시 UTF-8에서 U+FFFD로 손상.

## 수정
- 선택 오프셋이 NaN 또는 비정수(유한값)이면 `"The selection offsets must be whole numbers."`로 거부. (±Infinity 클램프 동작은 기존 유지)
- 경계가 유효한 서로게이트 쌍 한가운데면 거부(fail-closed). 쌍 경계 정렬, 결합 문자(e + U+0301) 앞 경계는 계속 허용. 범위를 자동 확장하지 않음(스코프 확대 방지).
- 신규 테스트 중 6건이 수정 전 코드에서 실패, 수정 후 통과(스태시로 확인).

## 결함 없음으로 확인한 항목
- LF/CRLF/무프론트매터/빈 문서/빈 본문(개행 유무)/전체 본문 경계에서 허용된 교체는 캡처 범위만 변경, prefix/suffix 바이트 동일(Buffer 비교). 추가되는 개행은 "프론트매터가 EOF에서 개행 없이 끝나는 경우의 본문"뿐이며 LF/CRLF를 따름.
- 오래된 스냅샷: 경로 다름, NFC→NFD, 이모지 1개 추가, CRLF 변환, 제로폭 문자 삽입, 프론트매터만 변경, 말미 개행 모두 거부.
- `safety.ts`: 외톨이 서로게이트, bidi, U+2028/2029, NEL(U+0085), NUL/DEL 차단. ZWSP/ㅤ(U+3164)/NBSP/BOM/VS16은 경고. 길이 한도는 UTF-16 단위.
- `diff.ts`: U+2028/2029/0085에서 줄을 나누지 않고 `\r\n`/`\r`/`\n` 구분 유지, 모든 케이스에서 before/after를 정확히 재구성.
- `review-text.ts`: 숨은 문자를 `⟦U+XXXX 이름⟧`로 노출, 마커 제거 시 원문 가시 문자 순서 보존, 정상 쌍 서로게이트/ZWJ 이모지/CR·LF는 그대로.

## 실행 결과
| 명령 | 결과 |
|---|---|
| `npx vitest run` | 16 파일, 241 테스트 통과 (기존 87 + 신규 154) |
| `npm run typecheck` | 오류 없음 |
| `npm run build` | 성공 |
| `npm run validate:release` | "Release metadata valid for agent-change-gate 0.2.0." |
기존 실패 없음. (리뷰 반영 후 재실행: 동일하게 16 파일 241 테스트, 신규 파일 154 테스트 통과.)

리뷰 반영: 첫 번째 표 테스트의 포괄적 `catch`를 제거하고, 예상된 거부(프론트매터 없는 노트의 frontmatter 스코프, 빈 선택)만 `toThrow(메시지)`로 명시 검증. 그 외 모든 예외는 테스트 실패로 처리됨.

## 남은 한계 (미수정·미검증)
- 실제 Obsidian GUI, Hermes 에이전트, `editor.posToOffset`/CodeMirror의 줄바꿈 정규화는 클라우드에서 실행 불가라 미검증. CRLF 노트에서 에디터 오프셋과 파일 바이트 오프셋의 관계는 가정에 의존.
- 자소 클러스터(결합 문자, ZWJ 시퀀스) 중간 경계는 허용됨(UTF-16 코드 유닛 기준 정확성만 보장). NFC/NFD 차이는 눈에 안 보이므로 diff에서 변경 줄로만 표시되고 별도 마커는 없음.
- CR 단독 줄바꿈(구형 Mac)이나 BOM으로 시작하는 노트는 프론트매터로 인식하지 않음(현행 동작, 테스트로 고정). 숨은 문자만으로 이뤄진 교체(예: U+200B, U+3164)는 `trim()`을 통과하므로 차단이 아닌 경고만 발생(정책 변경 아님으로 유지).
