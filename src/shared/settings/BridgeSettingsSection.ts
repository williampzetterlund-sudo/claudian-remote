import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';

import { t } from '../../i18n/i18n';
import {
  IGNIS_BRIDGE_TOKEN_STORAGE_KEY,
  IGNIS_BRIDGE_URL_STORAGE_KEY,
  readBridgeSetting,
  refreshBridgeConfig,
  writeBridgeSetting,
} from '../../providers/claude/runtime/remoteSpawn';

/**
 * Remote-bridge configuration (URL + token + connection test). Rendered both
 * in the settings tab and in the standalone command modal: the modal exists
 * because remote runtimes are exactly the environments where reaching the
 * full settings surface can be hard (Ignis's declarative settings pane does
 * not render, and on mobile the command palette is the fastest path).
 *
 * Values live in localStorage on purpose: they are per-device secrets and
 * must never travel with data.json through vault sync.
 */
export function renderBridgeSettingsSection(container: HTMLElement): void {
  new Setting(container).setName(t('settings.bridge.heading')).setHeading();

  new Setting(container)
    .setName(t('settings.bridge.url.name'))
    .setDesc(t('settings.bridge.url.desc'))
    .addText((text) => {
      text
        .setPlaceholder('wss://bridge.example.com')
        .setValue(readBridgeSetting(IGNIS_BRIDGE_URL_STORAGE_KEY) ?? '')
        .onChange((value) => {
          writeBridgeSetting(IGNIS_BRIDGE_URL_STORAGE_KEY, value.trim() || null);
        });
    });

  new Setting(container)
    .setName(t('settings.bridge.token.name'))
    .setDesc(t('settings.bridge.token.desc'))
    .addText((text) => {
      if (text.inputEl) text.inputEl.type = 'password';
      text
        .setValue(readBridgeSetting(IGNIS_BRIDGE_TOKEN_STORAGE_KEY) ?? '')
        .onChange((value) => {
          writeBridgeSetting(IGNIS_BRIDGE_TOKEN_STORAGE_KEY, value.trim() || null);
        });
    });

  new Setting(container)
    .setName(t('settings.bridge.test.name'))
    .setDesc(t('settings.bridge.test.desc'))
    .addButton((button) => {
      button.setButtonText(t('settings.bridge.test.button')).onClick(async () => {
        button.setDisabled(true);
        try {
          const config = await refreshBridgeConfig();
          new Notice(t('settings.bridge.test.ok', { vaultRoot: config.vaultRoot ?? '?' }));
        } catch (error) {
          new Notice(
            `${t('settings.bridge.test.fail')}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          button.setDisabled(false);
        }
      });
    });
}

export class BridgeConfigModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    renderBridgeSettingsSection(this.contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
