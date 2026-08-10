# Agent Change Gate 빠른 안내

> Hermes와 호환 ACP 에이전트가 이 채팅으로 돌려준 편집안을 범위 검사하고, 사용자가 검토하기 전까지 초안으로 유지하는 Obsidian 데스크톱 플러그인입니다.

현재 버전 `0.2.0`은 수동 설치용 공개 프리릴리스입니다. [GitHub Releases](https://github.com/Bum-Boo/agent-change-gate/releases/tag/0.2.0)에서 내려받을 수 있지만 Obsidian Community Plugins에는 아직 등록되지 않았습니다. 자동 테스트와 Hermes Agent 0.20.0의 ACP 초기화는 확인했지만, 실제 모델 대화·Obsidian GUI 전체 흐름·외부 베타 사용은 아직 검증되지 않았습니다.

## 무엇을 보호하나

- 현재 노트 본문, 현재 선택 영역, 기존 YAML frontmatter 중 하나만 명시적으로 전송합니다.
- 에이전트가 돌려준 교체안은 완전한 범위의 diff로 보여주며, 사용자가 승인해야만 적용합니다.
- 응답을 기다리는 동안 노트 경로나 대상 내용이 달라지면 적용을 거부합니다.
- ACP 파일시스템·터미널 권한을 제공하지 않고, 권한 요청은 거부합니다.
- 범위 영수증에는 지시문, 노트 본문, 모델 응답 원문을 기록하지 않습니다.

이 보호는 Agent Change Gate가 보내는 문맥과 직접 수행하는 노트 쓰기에만 적용됩니다. 별도 프로세스로 실행되는 Hermes나 다른 ACP 에이전트를 운영체제 수준에서 격리하지는 않습니다. 에이전트는 자체 도구·네트워크·모델 공급자·자격증명을 사용할 수 있습니다.

## 설치

1. [0.2.0 프리릴리스](https://github.com/Bum-Boo/agent-change-gate/releases/tag/0.2.0)에서 `agent-change-gate-0.2.0.zip`을 받습니다.
2. 압축의 전체 내용을 다음 폴더에 풉니다.

   ```text
   <vault>/.obsidian/plugins/agent-change-gate/
   ```

3. Obsidian의 **설정 → 커뮤니티 플러그인**에서 플러그인을 새로고침하고 **Agent Change Gate**를 켭니다.
4. **설정 → Agent Change Gate**에서 **Detect and check agents**를 실행합니다.

## Hermes로 시작하기

[Hermes Agent](https://github.com/NousResearch/hermes-agent)는 사용자가 별도로 설치하고 설정해야 하는 외부 프로그램입니다. 이 프로젝트에 포함되거나 이 프로젝트가 유지보수하지 않습니다. 기본 실행 형식은 다음과 같습니다.

```text
hermes -p <profile-id> acp
```

Windows에서는 WSL Hermes를 먼저 자동 탐색하며, 필요하면 Linux 실행 파일의 절대 경로를 설정할 수 있습니다. 플러그인은 Hermes 프로필을 설치·업데이트·수정하지 않습니다.

## 사용 흐름

1. Markdown 노트를 열고 오른쪽 사이드바에서 Agent Change Gate를 엽니다.
2. 에이전트, **Ask** 또는 **Suggest an edit**, 노트 범위를 고릅니다.
3. 요청을 보냅니다. Enter는 전송, Shift+Enter는 줄바꿈입니다.
4. 편집안이면 추가·삭제 줄을 모두 검토하고 **Apply this edit** 또는 **Discard**를 선택합니다.
5. 필요하면 **Stop**으로 로컬 대기를 중단하고 ACP 취소를 요청합니다. 취소된 요청의 편집안은 적용되지 않습니다.

## 개인정보와 제한

플러그인 자체에는 HTTP 요청이나 텔레메트리가 없습니다. 다만 ACP 에이전트가 선택한 노트 내용과 지시문을 구성된 모델 공급자에게 보낼 수 있고 비용이 발생할 수 있습니다. 로컬 플러그인 데이터에는 제한된 채팅 기록, 복구 체크포인트, 실행 설정, 범위 영수증이 평문으로 저장될 수 있습니다.

민감한 노트에 사용하기 전에 [개인정보 문서](../PRIVACY.md)와 [보안 정책](../SECURITY.md)을 읽으세요. 정확한 검증 수준은 [호환성 표](COMPATIBILITY.md), 오픈소스 출처와 라이선스는 [출처 문서](OPEN_SOURCE.md)에서 확인할 수 있습니다.
