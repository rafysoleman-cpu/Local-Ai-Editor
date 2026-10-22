/**
 * Application settings with validation and change notification.
 */
import type { AppSettings } from '@shared/app-types';
import { appSettingsSchema, createDefaultSettings, normalizeSettings } from '@shared/validation';
import type { Logger } from '../logging/logger';
import type { FileStorage } from '../storage/file-storage';
import { STORAGE_PATHS } from '../storage/paths';
import { AppError } from '../util/errors';

export class SettingsService {
  private settings: AppSettings = createDefaultSettings();
  private readonly listeners = new Set<(settings: AppSettings, changedKeys: string[]) => void>();

  constructor(
    private readonly storage: FileStorage,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    await this.reload();
    if (!(await this.storage.exists(STORAGE_PATHS.settings))) {
      await this.storage.writeJson(STORAGE_PATHS.settings, this.settings, { backup: false });
    }
  }

  async reload(): Promise<AppSettings> {
    const raw = await this.storage.readJson<unknown>(
      STORAGE_PATHS.settings,
      appSettingsSchema.partial(),
      {},
    );
    this.settings = normalizeSettings(raw);
    return this.settings;
  }

  get(): AppSettings {
    return this.settings;
  }

  onChange(listener: (settings: AppSettings, changedKeys: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const cleanPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) cleanPatch[key] = value;
    }
    if (Object.keys(cleanPatch).length === 0) return this.settings;

    const merged = {
      ...this.settings,
      ...cleanPatch,
      generation: { ...this.settings.generation, ...(cleanPatch.generation as object | undefined) },
      context: { ...this.settings.context, ...(cleanPatch.context as object | undefined) },
      limits: { ...this.settings.limits, ...(cleanPatch.limits as object | undefined) },
      permissions: { ...this.settings.permissions, ...(cleanPatch.permissions as object | undefined) },
      layout: { ...this.settings.layout, ...(cleanPatch.layout as object | undefined) },
    };
    const parsed = appSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new AppError(
        `Invalid settings: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        'INVALID',
      );
    }
    this.settings = parsed.data;
    await this.storage.writeJson(STORAGE_PATHS.settings, this.settings);
    const changedKeys = Object.keys(cleanPatch);
    this.logger.info('settings', 'Settings updated', { keys: changedKeys });
    for (const listener of this.listeners) {
      try {
        listener(this.settings, changedKeys);
      } catch {
        /* ignore listener failures */
      }
    }
    return this.settings;  }
}
