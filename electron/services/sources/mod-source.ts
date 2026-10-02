import type { ModDefinition, ModVersion } from '../../../src/shared/model';

export interface CatalogueOptions {
  refresh?: boolean;
}
export interface ModSource {
  readonly id: string;
  readonly displayName: string;
  getCatalogue(options?: CatalogueOptions): Promise<ModDefinition[]>;
  getMod(id: string): Promise<ModDefinition | null>;
  getVersions(id: string): Promise<ModVersion[]>;
}

export class LocalModSource implements ModSource {
  readonly id = 'local';
  readonly displayName = 'Local files';
  constructor(private entries: () => ModDefinition[]) {}
  async getCatalogue() {
    return this.entries();
  }
  async getMod(id: string) {
    return this.entries().find((mod) => mod.id === id) ?? null;
  }
  async getVersions(id: string) {
    return (await this.getMod(id))?.versions ?? [];
  }
}
