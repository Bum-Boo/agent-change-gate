# Agent Change Gate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md)

[![CI](https://github.com/Bum-Boo/agent-change-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/Bum-Boo/agent-change-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

> 이 채팅을 통해 ACP가 제안한 편집은 범위 검사를 거치며, 사용자가 검토하기 전까지 초안으로 유지됩니다.

Agent Change Gate는 신중한 노트 작업을 위한 데스크톱 ACP 클라이언트입니다. 요청을 보낼 때 현재 노트 본문, 정확한 선택 영역, 기존 YAML frontmatter 중 하나를 고릅니다. 플러그인은 그 범위를 캡처하고 대화를 노트 및 에이전트에 연결하며, 제안된 모든 교체 내용을 초안으로 취급합니다.

검토 가능한 초안은 범위가 제한된 완전한 줄 단위 diff로 표시되며 승인한 뒤에만 적용됩니다. 보통 크기의 비교에는 정확한 줄 diff를 사용하고, 정확한 비교 작업이 한도를 넘으면 모달은 거칠지만 완전한 삭제/추가 대체 표시를 사용합니다. 완전히 렌더링할 수 없는 대형 제안은 적용할 수 없습니다. 에이전트가 응답하는 동안 노트 경로나 캡처된 내용이 바뀌면 오래된 텍스트에 적용하지 않고 제안을 거부합니다.

> 상태: 수동 테스트용 공개 프리릴리스(`0.2.0`)입니다. GitHub Releases에서 받을 수 있지만 Obsidian Community Plugins에는 아직 등록되지 않았습니다. 핵심 도우미, 전송 한도, 세션 수명 주기, 상태 보존에는 자동 테스트가 있고 Hermes ACP 초기화도 확인했습니다. Obsidian GUI/모델 흐름, 외부 베타 사용, 더 넓은 호환성은 아직 검증되지 않았습니다.

## 게이트가 다루는 범위

게이트는 Agent Change Gate에서 선택한 문맥과 Agent Change Gate가 수행하는 노트 쓰기를 다룹니다.

- 기본적으로 호스트 프롬프트에 들어가는 현재 노트 텍스트는 선택한 본문, 선택 영역, frontmatter 범위뿐입니다.
- 선택형 문맥 제어를 켜면 동일한 정확한 범위 식별자(종류, 위치, 내용)에 연결된 최근 사용자/어시스턴트 표시 메시지를 최대 12개까지 추가로 보낼 수 있습니다.
- 대화는 에이전트 실행 식별자와 볼트 상대 노트 경로별로 분리되어, 실행 파일이나 작업공간을 바꿔도 이전 문맥이 조용히 전달되지 않습니다.
- ACP 클라이언트 파일시스템·터미널 기능을 부여하지 않으며 권한 요청은 안전하게 거부합니다.
- 플러그인이 적용하는 모든 노트 변경에는 명시적인 diff 승인이 필요합니다.
- 오래된 노트 경로 또는 내용 스냅샷은 거부합니다.
- 제한된 검토 diff를 렌더링할 수 있을 때 로컬 체크포인트로 보호된 실행 취소를 한 번 지원합니다.
- 범위 영수증은 크기, 결정적 해시, 결과를 기록하지만 지시문·노트 본문·모델 응답 원문은 생략합니다.

## 다루지 않는 범위

Agent Change Gate는 ACP 프로세스를 샌드박스하지 **않습니다**. Hermes와 다른 에이전트는 별도 로컬 프로세스로 실행되며 자체 도구, 네트워크 접근, 모델 공급자, 자격증명, 메모리, 운영체제 권한을 가질 수 있습니다. 게이트는 에이전트가 선택 범위 밖의 데이터에 접근할 수 없다는 것, 내용이 기기에만 남는다는 것, 다른 플러그인이 볼트를 변경할 수 없다는 것을 보장하지 않습니다.

신뢰하는 에이전트만 사용하세요. 실제 프로세스 보안 경계가 필요하면 격리된 OS 계정, VM 또는 컨테이너를 사용하세요.

## 적합한 용도

- 같은 노트와 에이전트로 돌아오는 집중형 대화
- 노트 본문, 선택 영역, frontmatter의 쓰기 전 검토 편집
- 무인 볼트 전체 변경보다 신중하고 되돌릴 수 있는 편집을 선호하는 사용자
- 하나의 ACP 런타임에 종속되지 않으면서 일급 탐색을 원하는 기존 Hermes 사용자

## 적합하지 않은 용도

- 무인 또는 대량 볼트 자동화
- 이 플러그인을 통한 에이전트의 직접 파일시스템·터미널 제어
- 모델, 공급자 계정, 에이전트 소프트웨어 설치 또는 구성
- 모바일 사용
- 운영체제 샌드박스 역할

## 요구 사항

- Obsidian 데스크톱 1.13.4 이상
- 구성된 프로필이 있는 Hermes Agent 또는 명시적으로 구성한 호환 ACP stdio 에이전트
- 모델/공급자 자격증명은 해당 에이전트가 관리해야 하며 이 플러그인에 붙여 넣지 않습니다.

Windows 네이티브 및 WSL 전송을 지원합니다. Windows에서 Hermes 자동 탐색은 WSL을 먼저 시도한 뒤 네이티브 실행 파일을 시도합니다.

## 테스트용 설치

1. [0.2.0 GitHub 프리릴리스](https://github.com/Bum-Boo/agent-change-gate/releases/tag/0.2.0)에서 `agent-change-gate-0.2.0.zip`을 받습니다.
2. 라이선스 고지까지 포함한 전체 압축 파일을 다음 위치에 풉니다.

   ```text
   <vault>/.obsidian/plugins/agent-change-gate/
   ```

   Obsidian은 `main.js`, `manifest.json`, `styles.css`를 로드합니다. `LICENSE`, `THIRD_PARTY_NOTICES.md`, `LICENSES/`도 같은 위치에 유지하세요.

3. Obsidian에서 **설정 → 커뮤니티 플러그인**을 열고 플러그인을 새로고침한 뒤 **Agent Change Gate**를 켭니다.
4. **설정 → Agent Change Gate**에서 **Detect and check agents**를 실행합니다.

## Hermes 빠른 시작

[Hermes Agent](https://github.com/NousResearch/hermes-agent)는 일급 설정 경로입니다. 실행 규약은 다음과 같습니다.

```text
hermes -p <profile-id> acp
```

`hermes`가 `PATH`에 없는 WSL 설치에서는 Linux 실행 파일의 절대 경로를 지정하세요. 플러그인은 Hermes 프로필을 설치, 업그레이드, 수정하지 않습니다. Hermes는 사용자가 설치하는 외부 소프트웨어이며 Agent Change Gate에 포함되거나 이 프로젝트가 유지보수하지 않습니다.

## 다른 ACP 에이전트

설정에서 다음 항목으로 argv 전용 실행 프로필을 등록할 수 있습니다.

- 안정적인 로컬 레이블
- 네이티브 또는 WSL 전송
- 실행 명령
- 줄마다 하나의 리터럴 인수
- 명시적인 ACP 작업 디렉터리

명령은 `shell: false`로 직접 실행됩니다. 사용자 정의 환경 변수 필드는 의도적으로 없습니다. 인수는 Obsidian 플러그인 데이터에 저장되므로 토큰, API 키, 비밀번호를 넣지 말고 에이전트 자체의 안전한 방식으로 자격증명을 구성하세요.

구성 가능하다는 것이 보편 호환을 뜻하지 않습니다. 정확한 테스트 버전은 [호환성 문서](COMPATIBILITY.md)를 확인하세요.

## 사용법

1. Markdown 노트를 엽니다.
2. 방패 모양 채팅 아이콘에서 Agent Change Gate를 엽니다.
3. 에이전트, **Ask** 또는 **Suggest an edit**, 범위를 고릅니다.
4. 요청을 보냅니다. Enter는 전송, Shift+Enter는 줄바꿈이며 활성 IME 조합 중에는 전송되지 않습니다.
5. **Stop**은 로컬 대기를 중단하고 ACP 취소를 요청합니다. 자식 프로세스가 무시할 수 있지만 해당 턴의 제안은 적용되지 않습니다.
6. 편집이면 추가·삭제 줄을 확인한 뒤 **Apply this edit** 또는 **Discard**를 고릅니다.
7. **Scope receipts**에서 지시문·노트 본문·모델 응답 원문을 생략한 로컬 결과 로그를 확인합니다.

## 범위 규칙

- **노트 본문**은 기존 YAML frontmatter를 제외합니다.
- **현재 선택 영역**은 전송 시 캡처된 비어 있지 않은 선택이 필요합니다.
- **YAML frontmatter**는 기존의 완전한 블록이 필요하며, 파싱 가능한 YAML을 포함한 완전한 교체 블록만 허용합니다.

승인된 편집도 활성 노트 경로나 정확한 노트 내용이 캡처 스냅샷과 다르면 거부됩니다.

## 개인정보와 로컬 데이터

플러그인 자체는 HTTP 요청을 하지 않으며 텔레메트리가 없습니다. 각 ACP 턴은 지시문, 볼트 상대 논리 노트 경로, 선택 범위 텍스트, 작업/범위 레이블을 포함합니다. 정확한 범위 스레드 문맥을 선택한 경우에만 최근 표시 사용자/어시스턴트 메시지를 최대 12개, 각 4,000자로 제한해 추가합니다. 에이전트는 이 내용을 구성된 모델 공급자에게 보내고 비용을 발생시킬 수 있습니다.

로컬 플러그인 데이터는 암호화되지 않은 평문이며 제한된 채팅 기록, 해당되는 전체 노트 전/후 복구 체크포인트, 비밀을 포함하면 안 되는 평문 실행 설정, 최대 500개·90일 보존 범위 영수증을 포함할 수 있습니다. 볼트 동기화나 백업 도구가 이 파일을 기기 밖으로 복사할 수 있습니다. 전체 한도는 200개 스레드와 메시지 2,000,000자이며 체크포인트 크기·개수·기간·총 저장량도 제한되어 큰 노트에는 플러그인 체크포인트가 없을 수 있습니다. 영수증에는 지시문, 노트 텍스트, 모델 응답이 없지만 결정적 해시는 추측한 내용을 확인하는 데 쓰일 수 있습니다. 채팅, 체크포인트, 영수증은 각각 지울 수 있습니다. 민감한 노트에 사용하기 전에 [PRIVACY.md](../PRIVACY.md)를 읽으세요.

## 보안 모델

호스트 측 제어에는 크기 제한이 있는 스키마 검증 응답 객체, 제한된 diff 작업, 비활성 평문 응답 렌더링, 정확한 오래된 스냅샷 검사, 쓰기 전 검토 diff, 셸 보간 없음, 제한된 자식 환경, 빈 ACP 클라이언트 기능, 클라이언트 파일시스템·터미널 메서드 거부, 안전 우선 권한 처리가 포함됩니다. 일급 Hermes 실행은 Hermes MCP 억제 플래그를 설정하고 빈 세션 MCP 목록을 보냅니다. 별도 프로세스는 호스트 요청을 무시할 수 있습니다.

이 제어는 호스트가 중개하는 우발적 접근을 줄이지만 자식 프로세스의 OS 샌드박스는 아닙니다. [SECURITY.md](../SECURITY.md)를 확인하세요.

일반 버그는 [GitHub Issues](https://github.com/Bum-Boo/agent-change-gate/issues)에 신고하세요. 민감한 볼트 내용이나 취약점 세부 사항을 공개 이슈에 올리지 말고 [SECURITY.md](../SECURITY.md)의 절차를 따르세요.

## 개발

```bash
npm ci
npm run check
```

격리된 테스트 볼트에만 배포하세요.

```powershell
$env:OBSIDIAN_LAB_VAULT='C:\absolute\path\to\lab-vault'
npm run deploy:lab
```

배포 스크립트는 볼트 루트에 `.agent-change-gate-lab` 파일이 있고 정확한 내용이 `agent-change-gate isolated test vault`인 경우에만 복사합니다. 테스트 볼트에 의도적으로 만들고 개인 또는 운영 볼트에는 추가하지 마세요.

## 오픈소스 기반

ACP 클라이언트, 런타임 검증, Obsidian API 타입, 빌드 시스템, 컴파일러, 테스트 러너는 확립된 오픈소스 프로젝트입니다. 확인된 정확한 버전, 역할, 업스트림 URL, 라이선스, 번들 여부는 [OPEN_SOURCE.md](OPEN_SOURCE.md)에 기록되어 있습니다. 런타임 고지와 번들 라이선스 전문은 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 및 [LICENSES](../LICENSES/)에도 있습니다.

Agent Change Gate는 독립 커뮤니티 프로젝트입니다. Obsidian, ACP, Hermes 또는 업스트림 프로젝트의 언급은 보증을 뜻하지 않습니다.

## 릴리스와 후원

버전 `0.2.0`은 Obsidian 런타임 자산, 프로젝트·제3자 라이선스 고지, 체크섬, 편의용 압축 파일을 갖춘 GitHub 프리릴리스입니다. GitHub 프리릴리스 제공 여부는 Obsidian Community Plugins 배포와 별개입니다.

후원은 활성화되어 있지 않습니다. 기부 URL이나 `.github/FUNDING.yml`도 제공하지 않습니다. 외부 베타 유지가 입증된 뒤에만 후원을 활성화해야 합니다. [COMMERCIALIZATION.md](COMMERCIALIZATION.md)를 참고하세요.

## 라이선스

[MIT](../LICENSE). 전체 의존성 출처 기록은 [OPEN_SOURCE.md](OPEN_SOURCE.md)를 확인하세요.

이 프로젝트를 각색하거나 공유할 때 [@Bum-Boo와 원본 저장소](https://github.com/Bum-Boo/agent-change-gate)를 언급해 주시면 감사하겠습니다. 이는 예의상 드리는 요청이며 MIT 라이선스의 요구 사항과는 별개이고 추가 조건도 아닙니다.
