import {
  App,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  TFile,
  type SettingDefinition,
  type SettingDefinitionItem,
} from 'obsidian';
import {
  emptyState,
  listCollections,
  runSync,
  SyncError,
  type Fetch,
  type NoteStore,
  type SyncSettings,
  type SyncState,
} from './sync';

interface PluginSettings extends SyncSettings {
  /** Minutes between syncs; 0 syncs only on command. */
  intervalMinutes: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: 'https://api.skyreader.app',
  appPassword: '',
  folder: 'Skyreader',
  scope: 'everything',
  collections: [],
  intervalMinutes: 30,
};

interface StoredData {
  settings?: Partial<PluginSettings>;
  state?: SyncState;
}

const fetchWithObsidian: Fetch = async (url, headers) => {
  // requestUrl isn't bound by CORS, so the backend needs no allowance for the app.
  const response = await requestUrl({ url, headers, throw: false });
  let json: unknown = null;
  try {
    json = response.json;
  } catch {
    // not JSON: the status says what happened
  }
  return { status: response.status, json };
};

export default class SkyreaderPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = emptyState();
  private syncing = false;
  private timer: number | null = null;

  async onload() {
    const data = ((await this.loadData()) ?? {}) as StoredData;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.state = { ...emptyState(), ...data.state };

    this.addCommand({
      id: 'sync',
      name: 'Sync highlights now',
      callback: () => void this.sync(true),
    });
    this.addRibbonIcon('highlighter', 'Sync Skyreader highlights', () => void this.sync(true));
    this.addSettingTab(new SkyreaderSettingTab(this.app, this));

    // A moved or renamed note is still the page's note.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        let changed = false;
        for (const [key, path] of Object.entries(this.state.notes)) {
          if (path === oldPath) {
            this.state.notes[key] = file.path;
            changed = true;
          }
        }
        if (changed) void this.persist();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.schedule();
      if (this.settings.appPassword) void this.sync(false);
    });
  }

  schedule() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.settings.intervalMinutes > 0) {
      this.timer = window.setInterval(
        () => void this.sync(false),
        this.settings.intervalMinutes * 60_000
      );
      this.registerInterval(this.timer);
    }
  }

  async persist() {
    await this.saveData({ settings: this.settings, state: this.state } satisfies StoredData);
  }

  /** `loud`: from a command, so say how it went; a background sync says only what needs fixing. */
  async sync(loud: boolean) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const result = await runSync(fetchWithObsidian, this.store(), this.settings, this.state);
      const changed = result.created + result.updated;
      if (loud || changed > 0 || result.failed > 0) {
        const parts =
          changed === 0 ? ['up to date'] : [`${result.created} new, ${result.updated} updated`];
        if (result.failed > 0) parts.push(`${result.failed} couldn't be written (see the console)`);
        new Notice(`Skyreader: ${parts.join('; ')}.`);
      }
    } catch (err) {
      // A background sync that can't reach the server stays quiet; one the
      // reader has to fix (a revoked password, a lapsed plan) says so.
      if (loud || (err instanceof SyncError && err.status !== undefined && err.status !== 429)) {
        new Notice(`Skyreader: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.syncing = false;
      await this.persist();
    }
  }

  collections() {
    return listCollections(fetchWithObsidian, this.settings);
  }

  private store(): NoteStore {
    const vault = this.app.vault;
    const file = (path: string) => {
      const found = vault.getAbstractFileByPath(normalizePath(path));
      return found instanceof TFile ? found : null;
    };
    return {
      read: async (path) => {
        const found = file(path);
        return found ? vault.read(found) : null;
      },
      exists: (path) => vault.getAbstractFileByPath(normalizePath(path)) !== null,
      create: async (path, content) => {
        await vault.create(normalizePath(path), content);
      },
      write: async (path, content) => {
        const found = file(path);
        if (found) await vault.modify(found, content);
      },
      setFrontmatter: async (path, fields) => {
        const found = file(path);
        if (!found) return;
        await this.app.fileManager.processFrontMatter(
          found,
          (frontmatter: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(fields)) {
              if (value === undefined) delete frontmatter[key];
              else frontmatter[key] = value;
            }
          }
        );
      },
      ensureFolder: async (path) => {
        const normalized = normalizePath(path);
        if (!vault.getAbstractFileByPath(normalized)) await vault.createFolder(normalized);
      },
    };
  }
}

class SkyreaderSettingTab extends PluginSettingTab {
  private collections: { id: string; name: string }[] | null = null;
  private collectionsError: string | null = null;
  private loadingCollections = false;

  constructor(
    app: App,
    private plugin: SkyreaderPlugin
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    return [
      {
        name: 'App password',
        desc: 'Make one in Skyreader under Settings → Notes & references. Highlight sync needs a Supporter plan.',
        // A password field, which the declarative text control can't be.
        render: (setting) => {
          setting.setName('App password');
          setting.addText((text) => {
            text.inputEl.type = 'password';
            text
              .setPlaceholder('xxxx-xxxx-xxxx-xxxx-xxxx')
              .setValue(settings.appPassword)
              .onChange(async (value) => {
                settings.appPassword = value.trim();
                this.forgetCollections();
                await this.plugin.persist();
              });
          });
        },
      },
      {
        name: 'Folder',
        desc: 'Where new notes go, one per article. Notes you move elsewhere stay synced.',
        control: { type: 'folder', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder },
      },
      {
        name: 'What to sync',
        desc: 'Everything you highlight, or every save in the Shelf collections you choose, highlighted or not.',
        control: {
          type: 'dropdown',
          key: 'scope',
          options: { everything: 'Everything highlighted', collections: 'Chosen collections' },
        },
      },
      ...(settings.scope === 'collections' ? [this.collectionsGroup()] : []),
      {
        name: 'Sync every',
        desc: 'Minutes between syncs. 0 syncs only when you run “Sync highlights now”.',
        control: {
          type: 'number',
          key: 'intervalMinutes',
          min: 0,
          step: 1,
          // Under 5 minutes would spend the server's allowance for nothing.
          validate: (minutes) =>
            Number.isInteger(minutes) && (minutes === 0 || minutes >= 5)
              ? undefined
              : 'Whole minutes, at least 5, or 0.',
        },
      },
      {
        name: 'Server',
        desc: 'Change only to sync from a Skyreader other than skyreader.app.',
        control: { type: 'text', key: 'serverUrl', placeholder: DEFAULT_SETTINGS.serverUrl },
      },
      {
        name: 'Sync now',
        desc: 'Sync without waiting for the next one.',
        action: () => void this.plugin.sync(true),
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    if (key.startsWith(COLLECTION))
      return settings.collections.includes(key.slice(COLLECTION.length));
    return settings[key as keyof PluginSettings];
  }

  async setControlValue(key: string, value: unknown) {
    const settings = this.plugin.settings;
    if (key.startsWith(COLLECTION)) {
      const id = key.slice(COLLECTION.length);
      settings.collections = value
        ? [...new Set([...settings.collections, id])]
        : settings.collections.filter((c) => c !== id);
    } else if (key === 'folder') {
      settings.folder = String(value);
    } else if (key === 'scope') {
      settings.scope = value === 'collections' ? 'collections' : 'everything';
    } else if (key === 'intervalMinutes') {
      const minutes = Number(value);
      settings.intervalMinutes = minutes === 0 ? 0 : Math.max(5, Math.floor(minutes) || 0);
    } else if (key === 'serverUrl') {
      settings.serverUrl = String(value).trim() || DEFAULT_SETTINGS.serverUrl;
      this.forgetCollections();
    }
    await this.plugin.persist();
    if (key === 'intervalMinutes') this.plugin.schedule();
    // The collections group comes and goes with the scope.
    if (key === 'scope') this.update();
  }

  private forgetCollections() {
    this.collections = null;
    this.collectionsError = null;
  }

  private collectionsGroup(): SettingDefinitionItem {
    const group = (items: SettingDefinition[]): SettingDefinitionItem => ({
      type: 'group',
      heading: 'Collections',
      items,
    });
    if (this.collectionsError !== null) {
      return group([
        {
          name: 'Couldn’t load your collections',
          desc: `${this.collectionsError} Click to try again.`,
          action: () => {
            this.collectionsError = null;
            this.update();
          },
          aliases: ['Try again'],
        },
      ]);
    }
    if (this.collections === null) {
      return group([
        {
          name: 'Loading your collections…',
          searchable: false,
          // Fetched when the tab shows it, not whenever definitions are read.
          render: () => this.loadCollections(),
        },
      ]);
    }
    if (this.collections.length === 0) {
      return group([
        {
          name: 'No collections yet',
          desc: 'Make one in Skyreader’s Library.',
          searchable: false,
        },
      ]);
    }
    return group(
      this.collections.map((collection) => ({
        name: collection.name,
        control: { type: 'toggle', key: `${COLLECTION}${collection.id}` },
      }))
    );
  }

  private loadCollections() {
    if (this.loadingCollections) return;
    this.loadingCollections = true;
    void this.plugin
      .collections()
      .then((list) => {
        this.collections = list;
      })
      .catch((err: unknown) => {
        this.collectionsError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.loadingCollections = false;
        this.update();
      });
  }
}

/** Control keys for the collection toggles: the prefix, then the collection's id. */
const COLLECTION = 'collection:';
