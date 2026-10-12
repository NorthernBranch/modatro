import type { AppState } from '../../src/shared/model';
import { HistorySchema, type OperationHistory } from '../../src/shared/features';
import { Storage } from './storage';

export class OperationHistoryStore {
  constructor(private storage: Storage) {}
  async status(): Promise<{ entries: OperationHistory; error?: string }> {
    try {
      return {
        entries: (await this.storage.read('data/operation-history.json', HistorySchema)) ?? [],
      };
    } catch {
      return {
        entries: [],
        error: 'Operation history is unavailable or invalid; recent outcomes cannot be verified.',
      };
    }
  }
  async read(): Promise<OperationHistory> {
    return (await this.status()).entries;
  }
  async record(
    id: string,
    before: AppState,
    after: AppState,
    outcome: OperationHistory[number]['outcome'],
    type?: string,
  ) {
    const changes = [
      ...new Set([...before.installations, ...after.installations].map((r) => r.modId)),
    ].filter(
      (key) =>
        JSON.stringify(before.installations.find((r) => r.modId === key)) !==
        JSON.stringify(after.installations.find((r) => r.modId === key)),
    );
    const entry: OperationHistory[number] = {
      id,
      time: new Date().toISOString(),
      type:
        type ??
        (changes.some(
          (key) =>
            before.installations.find((r) => r.modId === key)?.modVersion !==
              after.installations.find((r) => r.modId === key)?.modVersion &&
            before.installations.some((r) => r.modId === key) &&
            after.installations.some((r) => r.modId === key),
        )
          ? 'update'
          : changes.some((key) => !before.installations.some((r) => r.modId === key))
            ? 'install'
            : changes.some((key) => !after.installations.some((r) => r.modId === key))
              ? 'uninstall'
              : 'enable-disable'),
      ids: changes.slice(0, 200),
      outcome,
      versions: changes.slice(0, 200).map((key) => ({
        id: key,
        before: before.installations.find((r) => r.modId === key)?.modVersion,
        after: after.installations.find((r) => r.modId === key)?.modVersion,
      })),
      profile:
        type === 'profile-switch'
          ? after.profiles?.items.find((p) => p.id === after.profiles!.activeId)?.name
          : undefined,
    };
    // Separate bounded history: never prune recovery journals or their backups.
    try {
      const current = await this.read();
      const index = current.findIndex((e) => e.id === id);
      if (index >= 0) current[index] = { ...entry, time: current[index]!.time };
      else current.push(entry);
      await this.storage.write(
        'data/operation-history.json',
        HistorySchema.parse(current.slice(-100)),
      );
    } catch {
      /* History must not interrupt recovery. */
    }
  }
  async recovered(id: string, outcome: 'success' | 'failed') {
    try {
      const history = await this.read(),
        entry = history.find((e) => e.id === id);
      if (entry) {
        entry.outcome = outcome;
        await this.storage.write('data/operation-history.json', history);
      }
    } catch {
      /* Preserve uncertain status if history cannot be updated. */
    }
  }
}
