import { randomUUID } from "node:crypto";

import { Notice, PluginSettingTab, Setting } from "obsidian";

import type { CustomAcpAgentDefinition } from "../core/types";
import type BoundedNoteChatPlugin from "../main";
import { AuditModal } from "./audit-modal";
import { ConfirmModal } from "./confirm-modal";

export class BoundedNoteChatSettingTab extends PluginSettingTab {
  private saveTimer: number | null = null;

  constructor(private readonly plugin: BoundedNoteChatPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Agent Change Gate").setHeading();
    containerEl.createEl("p", {
      text: "Hermes has first-class discovery, and compatible ACP agents can be added explicitly. The selected note scope goes to the chosen local agent process; visible thread history is added only when exact-scope context is selected. The process may use a remote model provider.",
    });

    new Setting(containerEl).setName("Hermes setup").setHeading();

    new Setting(containerEl)
      .setName("Discover Hermes")
      .setDesc("Turn off when you use only explicitly configured ACP agents.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.state.settings.hermesEnabled)
        .onChange(async (value) => {
          this.plugin.state.settings.hermesEnabled = value;
          await this.plugin.configurationChanged();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Launch mode")
      .setDesc("Auto tries WSL first on Windows, then a native Hermes executable.")
      .addDropdown((dropdown) => dropdown
        .addOption("auto", "Auto")
        .addOption("wsl", "WSL")
        .addOption("native", "Native")
        .setValue(this.plugin.state.settings.launchMode)
        .onChange(async (value) => {
          this.plugin.state.settings.launchMode = value === "wsl" || value === "native" ? value : "auto";
          await this.plugin.configurationChanged();
        }));

    new Setting(containerEl)
      .setName("WSL distribution")
      .setDesc("Optional. Used by Hermes discovery and custom WSL ACP profiles. Leave empty for the default distribution.")
      .addText((text) => text
        .setPlaceholder("Ubuntu")
        .setValue(this.plugin.state.settings.wslDistribution)
        .onChange(async (value) => {
          this.plugin.state.settings.wslDistribution = value.trim().slice(0, 128);
          this.scheduleConfigurationSave();
        }));

    new Setting(containerEl)
      .setName("Hermes executable")
      .setDesc("Optional absolute path. For WSL, enter the Linux path. Leave empty when hermes is on PATH.")
      .addText((text) => text
        .setPlaceholder("/path/to/hermes")
        .setValue(this.plugin.state.settings.hermesExecutable)
        .onChange(async (value) => {
          this.plugin.state.settings.hermesExecutable = value.trim().slice(0, 4_096);
          this.scheduleConfigurationSave();
        }));

    new Setting(containerEl)
      .setName("Custom Hermes home")
      .setDesc("Native launch only. Leave empty for the standard ~/.hermes location.")
      .addText((text) => text
        .setPlaceholder("~/.hermes")
        .setValue(this.plugin.state.settings.hermesHome)
        .onChange(async (value) => {
          this.plugin.state.settings.hermesHome = value.trim().slice(0, 4_096);
          this.scheduleConfigurationSave();
        }));

    new Setting(containerEl)
      .setName("Agent profiles")
      .setDesc("Optional comma-separated Hermes profile allowlist. Leave empty to discover all Hermes profiles.")
      .addText((text) => text
        .setPlaceholder("default, my-agent")
        .setValue(this.plugin.state.settings.agentProfiles.join(", "))
        .onChange(async (value) => {
          this.plugin.state.settings.agentProfiles = value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item))
            .filter((item, index, items) => items.indexOf(item) === index)
            .slice(0, 64);
          this.scheduleConfigurationSave();
        }));

    this.renderCustomAgents(containerEl);

    new Setting(containerEl)
      .setName("Context limit")
      .setDesc("Maximum characters sent from one note scope (2,000–300,000).")
      .addText((text) => text
        .setValue(String(this.plugin.state.settings.maxContextChars))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) {
            this.plugin.state.settings.maxContextChars = Math.round(Math.min(300_000, Math.max(2_000, parsed)));
            this.scheduleSave();
          }
        }));

    new Setting(containerEl)
      .setName("Response timeout")
      .setDesc("Seconds before an ACP initialize or turn is cancelled (15–600).")
      .addText((text) => text
        .setValue(String(Math.round(this.plugin.state.settings.promptTimeoutMs / 1_000)))
        .onChange(async (value) => {
          const seconds = Number(value);
          if (Number.isFinite(seconds)) {
            this.plugin.state.settings.promptTimeoutMs = Math.round(
              Math.min(600, Math.max(15, seconds)) * 1_000,
            );
            this.scheduleSave();
          }
        }));

    new Setting(containerEl)
      .setName("Messages kept per thread")
      .setDesc("Local user, assistant, and system messages retained for each agent/note pair (4–100). When exact-scope context is selected, up to 12 recent matching user/assistant messages are sent in a turn.")
      .addText((text) => text
        .setValue(String(this.plugin.state.settings.historyLimit))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return;
          const limit = Math.round(Math.min(100, Math.max(4, parsed)));
          this.plugin.state.settings.historyLimit = limit;
          for (const thread of Object.values(this.plugin.state.threads)) {
            if (thread.messages.length > limit) {
              thread.messages.splice(0, thread.messages.length - limit);
            }
          }
          this.scheduleSave();
        }));

    new Setting(containerEl)
      .setName("Detect and check agents")
      .setDesc(this.plugin.diagnostics?.message ?? "Discover configured agents and initialize the default ACP profile. Agent Change Gate sends no model prompt; executable startup behavior is outside the gate.")
      .addButton((button) => button
        .setButtonText("Run check")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Checking…");
          try {
            const diagnostics = await this.plugin.refreshAgents(false);
            const profile = this.plugin.agents.find((item) => item.id === this.plugin.state.settings.defaultAgent)
              ?? this.plugin.agents[0];
            if (diagnostics.ok && profile) {
              const check = await this.plugin.checkProfile(profile);
              new Notice(check.message);
            } else {
              new Notice(diagnostics.message);
            }
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "ACP agent check failed.");
          } finally {
            button.setDisabled(false).setButtonText("Run check");
            this.display();
          }
        }));

    if (this.plugin.agents.length > 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: `Ready profiles: ${this.plugin.agents.map((profile) => profile.label).join(", ")}`,
      });
    }

    new Setting(containerEl).setName("Safety and privacy").setHeading();
    containerEl.createEl("p", {
      text: "The ACP client grants no filesystem or terminal capability and denies permission requests. First-class Hermes launches set its MCP-suppression flag and send an empty session MCP list. This is a host-side review gate, not an OS sandbox: the separate agent process and its model provider may still process the scope you send.",
    });

    new Setting(containerEl)
      .setName("Scope receipts")
      .setDesc(`${this.plugin.state.auditLog.length.toLocaleString()} request receipts are stored locally without instruction, note-body, or model-response plaintext (maximum 500, retained for 90 days). Hashes are deterministic fingerprints, not anonymization.`)
      .addButton((button) => button
        .setButtonText("View receipts")
        .onClick(() => new AuditModal(this.app, this.plugin.state.auditLog).open()))
      .addButton((button) => button
        .setButtonText("Clear receipts")
        .setWarning()
        .onClick(async () => {
          const accepted = await new ConfirmModal(
            this.app,
            "Clear all scope receipts?",
            "This deletes local request metadata only. Chats, recovery snapshots, notes, and agent-side records are unchanged.",
            "Clear receipts",
          ).waitForDecision();
          if (!accepted) return;
          const previousAuditLog = this.plugin.state.auditLog;
          this.plugin.state.auditLog = [];
          try {
            await this.plugin.saveState();
          } catch {
            const merged = new Map(previousAuditLog.map((record) => [record.id, record]));
            for (const record of this.plugin.state.auditLog) merged.set(record.id, record);
            this.plugin.state.auditLog = [...merged.values()]
              .sort((left, right) => left.createdAt - right.createdAt);
            new Notice("Scope receipts were not cleared because the local state file could not be updated.");
            return;
          }
          new Notice("Scope receipts cleared.");
          this.display();
        }));

    new Setting(containerEl)
      .setName("Clear local chat history")
      .setDesc("Deletes all threads stored by this plugin. Notes and agent profiles are not changed.")
      .addButton((button) => button
        .setButtonText("Clear chats")
        .setWarning()
        .onClick(async () => {
          const accepted = await new ConfirmModal(
            this.app,
            "Clear all local chat history?",
            "This cannot be undone. It does not delete or edit any notes.",
            "Clear chats",
          ).waitForDecision();
          if (!accepted) return;
          const previousThreads = this.plugin.state.threads;
          this.plugin.state.threads = {};
          try {
            await this.plugin.saveState();
          } catch {
            this.plugin.state.threads = {
              ...previousThreads,
              ...this.plugin.state.threads,
            };
            new Notice("Chat history was not cleared because the local state file could not be updated.");
            return;
          }
          this.plugin.acpPool.reset();
          new Notice("Local chat history cleared.");
        }));

    new Setting(containerEl)
      .setName("Clear recovery snapshots")
      .setDesc("Deletes local before/after copies kept for the plugin's undo command. Snapshots also expire after 30 days.")
      .addButton((button) => button
        .setButtonText("Clear snapshots")
        .setWarning()
        .onClick(async () => {
          const accepted = await new ConfirmModal(
            this.app,
            "Clear all recovery snapshots?",
            "The plugin's own undo command will no longer restore those edits. Obsidian's normal undo and file recovery are unchanged.",
            "Clear snapshots",
          ).waitForDecision();
          if (!accepted) return;
          const previousCheckpoints = this.plugin.state.checkpoints;
          this.plugin.state.checkpoints = {};
          try {
            await this.plugin.saveState();
          } catch {
            this.plugin.state.checkpoints = {
              ...previousCheckpoints,
              ...this.plugin.state.checkpoints,
            };
            new Notice("Recovery snapshots were not cleared because the local state file could not be updated.");
            return;
          }
          new Notice("Recovery snapshots cleared.");
        }));
  }

  private renderCustomAgents(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Other ACP agents (advanced)").setHeading();
    containerEl.createEl("p", {
      text: "Each profile is launched as a literal executable plus argv, never as a shell command. Arguments are stored locally: do not put tokens, API keys, or passwords in them.",
    });

    const definitions = this.plugin.state.settings.customAcpAgents ??= [];
    for (const definition of definitions) {
      new Setting(containerEl)
        .setName(definition.label.trim() || "Unnamed ACP agent")
        .setDesc(`Local profile ID: ${definition.id}`)
        .setHeading();

      new Setting(containerEl)
        .setName("Label")
        .setDesc("Shown in the chat agent picker.")
        .addText((text) => text
          .setPlaceholder("My ACP agent")
          .setValue(definition.label)
          .onChange(async (value) => {
            definition.label = value.trim().slice(0, 128);
            this.scheduleConfigurationSave();
          }));

      new Setting(containerEl)
        .setName("Transport")
        .setDesc("Native starts the executable directly. WSL starts it through wsl.exe --exec.")
        .addDropdown((dropdown) => dropdown
          .addOption("native", "Native")
          .addOption("wsl", "WSL")
          .setValue(definition.transport ?? "native")
          .onChange(async (value) => {
            definition.transport = value === "wsl" ? "wsl" : "native";
            this.scheduleConfigurationSave();
          }));

      new Setting(containerEl)
        .setName("Executable")
        .setDesc("A program name on PATH or an absolute executable path. Do not enter a shell command line.")
        .addText((text) => text
          .setPlaceholder(definition.transport === "wsl" ? "/usr/local/bin/my-agent" : "C:\\path\\to\\my-agent.exe")
          .setValue(definition.launch.command)
          .onChange(async (value) => {
            definition.launch.command = value.trim().slice(0, 4_096);
            this.scheduleConfigurationSave();
          }));

      new Setting(containerEl)
        .setName("Arguments")
        .setDesc("One literal argument per line. Quotes and spaces are not shell-parsed.")
        .addTextArea((area) => {
          area
            .setPlaceholder("acp\n--profile\nwork")
            .setValue(definition.launch.args.join("\n"))
            .onChange(async (value) => {
              definition.launch.args = value.length === 0
                ? []
                : value
                  .split(/\r?\n/)
                  .slice(0, 64)
                  .map((argument) => argument.slice(0, 4_096));
              this.scheduleConfigurationSave();
            });
          area.inputEl.rows = 4;
        });

      new Setting(containerEl)
        .setName("ACP working directory")
        .setDesc("An absolute path sent as the ACP session cwd. Keep it outside the vault.")
        .addText((text) => text
          .setPlaceholder(definition.transport === "wsl" ? "/home/you" : "C:\\Users\\you")
          .setValue(definition.workspace)
          .onChange(async (value) => {
            definition.workspace = value.trim().slice(0, 4_096);
            this.scheduleConfigurationSave();
          }));

      new Setting(containerEl)
        .setName("Remove custom profile")
        .setDesc("Removes only this launch definition and resets its local ACP connection.")
        .addButton((button) => button
          .setButtonText("Remove")
          .setWarning()
          .onClick(async () => {
            const accepted = await new ConfirmModal(
              this.app,
              `Remove ${definition.label || definition.id}?`,
              "This does not uninstall or reconfigure the agent executable. Existing local chat history is kept until you clear it.",
              "Remove profile",
            ).waitForDecision();
            if (!accepted) return;
            this.plugin.state.settings.customAcpAgents = definitions.filter((item) => item.id !== definition.id);
            await this.plugin.configurationChanged();
            this.display();
          }));
    }

    new Setting(containerEl)
      .setName("Add custom ACP agent")
      .setDesc("Create an empty argv-only profile, then fill every field and run the agent check.")
      .addButton((button) => button
        .setButtonText("Add agent")
        .setDisabled(definitions.length >= 64)
        .onClick(async () => {
          if (definitions.length >= 64) {
            new Notice("At most 64 custom ACP profiles can be stored.");
            return;
          }
          const definition: CustomAcpAgentDefinition = {
            id: `custom-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            label: "Custom ACP agent",
            workspace: "",
            transport: "native",
            launch: { command: "", args: [] },
          };
          definitions.push(definition);
          this.scheduleConfigurationSave();
          this.display();
        }));
  }

  private scheduleConfigurationSave(): void {
    this.plugin.invalidateAgentConfiguration();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveState().catch(() => {
        new Notice("Settings were not saved because the local state file could not be updated.");
      });
    }, 350);
  }
}
