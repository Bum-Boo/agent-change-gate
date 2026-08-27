# Agent Change Gate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md)

[![CI](https://github.com/Bum-Boo/agent-change-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/Bum-Boo/agent-change-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

> ACP 通过此聊天返回的编辑建议会经过范围检查，并在你审阅之前一直保持为草稿。

Agent Change Gate 是一款用于审慎处理笔记的桌面 ACP 客户端。发送请求时，可选择当前笔记正文、精确选区或现有 YAML frontmatter。插件会捕获该范围，将对话与笔记和代理绑定，并把每项替换建议都视为草稿。

草稿以有界且完整的逐行 diff 显示，只有批准后才会应用。普通大小的比较使用精确逐行 diff；精确计算超出上限时，窗口会改用较粗略但完整的删除/添加视图。无法完整呈现的超大建议不能应用。如果代理响应期间笔记路径或已捕获内容发生变化，建议会被拒绝，而不会应用到过期文本。

> 状态：用于手动测试的公开预发布版（`0.2.0`）。可从 GitHub Releases 下载，但尚未进入 Obsidian Community Plugins。核心辅助逻辑、传输边界、会话生命周期和状态保留均有自动化测试，Hermes ACP 初始化也已验证。Obsidian GUI/模型工作流、外部 Beta 使用和更广泛的兼容性仍未验证。

## 保护范围

此门控仅覆盖在 Agent Change Gate 中选择的上下文，以及由 Agent Change Gate 执行的笔记写入。

- 默认情况下，主机提示中唯一的当前笔记文本是所选正文、选区或 frontmatter。
- 可选择额外发送与完全相同范围标识（类型、区间和内容）相关的最多 12 条近期可见用户/助手消息。
- 对话按代理启动身份和仓库相对笔记路径隔离；更换可执行文件或工作区不会悄然转发旧上下文。
- 不授予 ACP 客户端文件系统或终端能力，权限请求按失败关闭处理。
- 插件应用的每项笔记更改都需要明确批准 diff。
- 过期的笔记路径或内容快照会被拒绝。
- 在有界审阅 diff 可以呈现时，本地检查点支持一次受保护的撤销。
- 范围收据记录大小、确定性哈希和结果，但不记录指令、笔记正文或模型响应明文。

## 不保护的范围

Agent Change Gate **不会**沙箱化 ACP 进程。Hermes 和其他代理作为独立本地进程运行，可能拥有自己的工具、网络访问、模型提供商、凭据、记忆和操作系统权限。本门控无法证明代理不能访问所选范围之外的数据、内容只留在设备上，或其他插件不能更改仓库。

只使用你信任的代理。需要真正的进程安全边界时，请使用隔离的操作系统账户、虚拟机或容器。

## 适用场景

- 回到同一笔记和代理的专注对话
- 对正文、选区和 frontmatter 先审阅后写入
- 偏好审慎、可恢复编辑而非无人值守全库更改的用户
- 希望获得 Hermes 一等检测，同时不锁定单一 ACP 运行时的用户

## 不适用场景

- 无人值守或批量仓库自动化
- 通过本插件授予代理直接文件系统或终端控制
- 安装或配置模型、提供商账户或代理软件
- 移动端使用
- 充当操作系统沙箱

## 要求

- Obsidian 桌面版 1.13.4 或更高版本
- 已配置配置文件的 Hermes Agent，或明确配置的兼容 ACP stdio 代理
- 模型/提供商凭据应由代理管理，切勿粘贴到本插件中

支持 Windows 原生和 WSL 传输。Windows 上的 Hermes 自动检测先尝试 WSL，再尝试原生可执行文件。

## 测试安装

1. 从 [0.2.0 GitHub 预发布版](https://github.com/Bum-Boo/agent-change-gate/releases/tag/0.2.0)下载 `agent-change-gate-0.2.0.zip`。
2. 将包含许可证通知的完整压缩包解压到：

   ```text
   <vault>/.obsidian/plugins/agent-change-gate/
   ```

   Obsidian 会加载 `main.js`、`manifest.json` 和 `styles.css`；请将 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和 `LICENSES/` 保留在旁边。

3. 在 Obsidian 中打开**设置 → 第三方插件**，重新加载插件并启用 **Agent Change Gate**。
4. 打开**设置 → Agent Change Gate**，运行 **Detect and check agents**。

## Hermes 快速开始

[Hermes Agent](https://github.com/NousResearch/hermes-agent) 是一等配置路径，其启动约定为：

```text
hermes -p <profile-id> acp
```

如果 WSL 安装未将 `hermes` 放入 `PATH`，请设置其 Linux 可执行文件的绝对路径。插件不会安装、升级或改写 Hermes 配置文件。Hermes 是用户另行安装的外部软件，不随本项目捆绑，也不由本项目维护。

## 其他 ACP 代理

可在设置中注册仅 argv 启动配置，包括稳定的本地标签、原生或 WSL 传输、可执行命令、每行一个字面参数，以及明确的 ACP 工作目录。

命令以 `shell: false` 直接启动。系统有意不提供自定义环境变量字段。参数会保存在 Obsidian 插件数据中，因此不要放入令牌、API 密钥或密码；请通过代理自身的安全机制配置凭据。

可配置不代表普遍兼容。精确测试版本见[兼容性文档](COMPATIBILITY.md)。

## 使用方法

1. 打开 Markdown 笔记。
2. 从带盾牌的聊天图标打开 Agent Change Gate。
3. 选择代理、**Ask** 或 **Suggest an edit**，以及范围。
4. 发送请求。Enter 发送，Shift+Enter 换行；IME 正在组字时不会提交。
5. **Stop** 会停止本地等待并请求 ACP 取消。子进程可能忽略请求，但该轮建议不会应用。
6. 对于编辑，检查新增和删除行，再选择 **Apply this edit** 或 **Discard**。
7. 打开 **Scope receipts** 查看本地结果日志；其中不含指令、笔记正文或模型响应明文。

## 范围规则

- **Note body** 不包含现有 YAML frontmatter。
- **Current selection** 必须是在发送时捕获的非空选区。
- **YAML frontmatter** 必须已有完整区块，且只接受包含可解析 YAML 的完整替换区块。

即使编辑已获批准，如果当前笔记路径或精确内容与捕获快照不符，也会被拒绝。

## 隐私与本地数据

插件本身不发出 HTTP 请求，也没有遥测。每轮 ACP 包含你的指令、仓库相对逻辑笔记路径、所选范围文本和任务/范围标签。只有选择精确范围线程上下文时，才会额外加入最多 12 条近期可见用户/助手消息，每条上限 4,000 字符。代理可能将其发送给所配置的模型提供商并产生费用。

本地插件数据是未加密明文，可能包含有界聊天记录、符合条件的整篇笔记前后恢复检查点、不得含秘密的明文启动设置，以及最多 500 条、保留 90 天的范围收据。同步或备份工具可能把该文件复制到设备外。全局最多保留 200 个线程和 2,000,000 个消息字符；检查点的大小、数量、期限和总存储也有限，因此大笔记可能没有插件检查点。收据不含指令、笔记或模型响应，但确定性哈希可用于验证猜测内容。聊天、检查点和收据可分别清除。处理敏感笔记前请阅读 [PRIVACY.md](../PRIVACY.md)。

## 安全模型

主机侧控制包括：带大小限制的架构验证响应对象、有界 diff 工作、惰性纯文本响应渲染、精确过期快照检查、写入前审阅 diff、无 shell 插值、受限子进程环境、空 ACP 客户端能力、拒绝客户端文件系统/终端方法，以及失败关闭权限处理。一等 Hermes 启动会设置 Hermes 的 MCP 抑制标志，并发送空会话 MCP 列表。独立进程可以忽略主机请求。

这些控制减少由主机中介的意外访问，但不是子进程的操作系统沙箱。请参阅 [SECURITY.md](../SECURITY.md)。普通问题请通过 [GitHub Issues](https://github.com/Bum-Boo/agent-change-gate/issues)报告。不要在公开问题中放入敏感仓库内容或漏洞详情；请遵循安全文档。

## 开发

```bash
npm ci
npm run check
```

仅部署到隔离的测试仓库：

```powershell
$env:OBSIDIAN_LAB_VAULT='C:\absolute\path\to\lab-vault'
npm run deploy:lab
```

只有仓库根目录含 `.agent-change-gate-lab`，且其精确文本为 `agent-change-gate isolated test vault` 时，部署脚本才会复制。请有意在测试仓库创建它，切勿添加到个人或生产仓库。

## 开源基础

ACP 客户端、运行时验证、Obsidian API 类型、构建系统、编译器和测试运行器均为成熟开源项目。仅有证据支持的精确版本、角色、上游 URL、许可证和捆绑状态记录于 [OPEN_SOURCE.md](OPEN_SOURCE.md)。运行时通知和完整捆绑许可证文本还保存在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 与 [LICENSES](../LICENSES/) 中。

Agent Change Gate 是独立社区项目。提及 Obsidian、ACP、Hermes 或任何上游项目不表示其认可。

## 发布与资助

版本 `0.2.0` 是 GitHub 预发布版，包含 Obsidian 运行资产、项目及第三方许可证通知、校验和与便利压缩包。GitHub 预发布可用性与 Obsidian Community Plugins 分发彼此独立。

资助尚未启用，项目不提供捐赠 URL 或 `.github/FUNDING.yml`。只有外部 Beta 留存得到证明后才应启用赞助；见 [COMMERCIALIZATION.md](COMMERCIALIZATION.md)。

## 许可证

[MIT](../LICENSE)。完整依赖来源记录见 [OPEN_SOURCE.md](OPEN_SOURCE.md)。

如果你改编或分享本项目，烦请提及 [@Bum-Boo 和原始仓库](https://github.com/Bum-Boo/agent-change-gate)。这是礼貌请求，与 MIT 许可证要求明确分开，也不是附加条件。
