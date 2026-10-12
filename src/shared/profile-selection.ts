import type { InstallationRecord, AppState } from './model';
import type { Selection, ProfileSummary } from './features';

export function selection(records: InstallationRecord[]): Selection {
  return records
    .map((r) => ({ id: r.modId, enabled: !r.disabled }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
// Save only the installed entries, preserving unrelated unsaved manual toggles.
// This state is committed with the files, never in a follow-up profile write.
export function withInstalledMods(state: AppState, records: InstallationRecord[]): AppState {
  const installed = new Map(records.map((record) => [record.modId, record]));
  const next = {
    ...state,
    installations: [
      ...state.installations.filter((record) => !installed.has(record.modId)),
      ...records,
    ],
  };
  if (!state.profiles) return next;
  return {
    ...next,
    profiles: {
      ...state.profiles,
      items: state.profiles.items.map((profile) => {
        const saved = new Map(profile.selection.map((entry) => [entry.id, entry]));
        for (const record of records)
          saved.set(record.modId, {
            id: record.modId,
            enabled:
              profile.id === state.profiles!.activeId
                ? !record.disabled
                : (saved.get(record.modId)?.enabled ?? false),
          });
        return {
          ...profile,
          selection: [...saved.values()].sort((a, b) => a.id.localeCompare(b.id)),
        };
      }),
    },
  };
}
export function profileSummary(state: AppState, unmanagedCount = 0): ProfileSummary | undefined {
  if (!state.profiles) return undefined;
  const desired = state.profiles.items.find((p) => p.id === state.profiles!.activeId)!.selection;
  const actual = selection(state.installations);
  const ids = new Set([...desired, ...actual].map((v) => v.id));
  const differences = [...ids].filter(
    (id) => desired.find((v) => v.id === id)?.enabled !== actual.find((v) => v.id === id)?.enabled,
  );
  return { ...state.profiles, unsaved: differences.length > 0, differences, unmanagedCount };
}
