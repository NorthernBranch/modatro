# Catalogue and installation verification

The main catalogue comes from Thunderstore. A user can optionally add a compatible
Balatro mod index by GitHub URL; the reviewed native supplement is a separate,
development opt-in source. All providers return normalized definitions to the same
installer and transaction engine.

## Discovery and distribution boundaries

| Boundary                     | Current behavior                                                                                                                                      | Evidence                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Runtime discovery            | Validated Thunderstore chunks and optional index metadata; no committed mirror of installed mod archives                                              | `catalogue.test.ts`, `mod-index.test.ts`, `source-migration.test.ts` |
| Deduplication and categories | Thunderstore takes priority for matching identities/repositories; managers are excluded and AI Generated tags are hidden with Other as fallback       | `mod-index.test.ts`, `thunderstore.test.ts`                          |
| Source transparency          | Thunderstore releases retain their package archives and requirements; linked GitHub manual archives are used for unsupported installers               | `trust.test.ts`, `thunderstore.test.ts`, `ui-requests.spec.ts`       |
| Registry/runtime versions    | Registry manifests must match selected package metadata; runtime requirements use supported loader/game versions without inventing package provenance | `thunderstore.test.ts`, `dependencies.test.ts`, `local-mods.test.ts` |
| Index release labels         | Staged metadata supplies runtime versions when index labels are hashes, timestamps or tags; fixed native release mismatches remain blocked            | `installer.test.ts`                                                  |
| Author metadata              | Stable identities, author manifests, explicit installation/update permissions and schema validation                                                   | `trust.test.ts`, `catalogue.test.ts`, catalogue compiler             |
| Public restrictions          | Bundled and saved append-only removals and blocked releases supersede cache; failed current checks pause new downloads                                | `trust.test.ts`, `catalogue.test.ts`                                 |
| API availability             | Shared GitHub cooldowns, recent JSON reuse and persisted optional star budgets; raw policies always reach their source                                | `github-requests.test.ts`, `github-stars.test.ts`                    |
| Offline management           | Cached browsing and local ownership records survive source removal, migration and outages                                                             | `external-mods.test.ts`, `storage.test.ts`, `catalogue.test.ts`      |

Cryptographic catalogue signatures are not implemented; feeds currently rely on
HTTPS, their maintained source, schema checks and saved revision history. Approval
and licence evidence still require human review. Registry publication and optional
index inclusion are not labelled as explicit Modatro author approval.

## Installation and recovery boundaries

| Boundary                | Current behavior                                                                                                                                                   | Evidence                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Local creator           | Deterministic whitelisted ZIPs, project/build provenance, separate drafts and protected catalogue replacement                                                      | `creator.test.ts`                                                        |
| Supported payloads      | ZIPs, declared mod roots, standalone Lua, Lovely patches and explicit game replacements; downloaded installers/scripts are not executed                            | `archive.test.ts`, `installer.test.ts`, `lovely.test.ts`                 |
| Wrapper folders         | Declared metadata takes priority over outer error patches; actual resources remain together and ambiguous archives stay blocked                                    | `archive.test.ts`, `wrapped-mods.test.ts`                                |
| Dependencies            | Required supported dependencies are reviewed, staged and committed before the requested mod; shared packages are deduplicated                                      | `source-migration.test.ts`, `application.test.ts`, `ui-requests.spec.ts` |
| Unknown loaders         | Explicit per-operation consent can acknowledge an installed unverified Lovely/Steamodded version; missing and known incompatible requirements cannot be overridden | `unverified-prerequisites.test.ts`, `dependencies.test.ts`               |
| Native libraries        | Lovely presence needs library evidence; managed version claims also require matching recorded binary hashes                                                        | `lovely.test.ts`, `local-mods.test.ts`                                   |
| Paths and archives      | Sender/input validation, HTTPS redirects, canonical roots, symlink rejection, traversal/case checks, ZIP CRC and resource limits                                   | `desktop.spec.ts`, `download.test.ts`, `archive.test.ts`                 |
| Ownership and integrity | File records, original backups, SHA-256 history and immutable-release checks protect managed and external files                                                    | `installer.test.ts`, `trust.test.ts`, `thunderstore.test.ts`             |
| Atomic changes          | Journalled batch commits, verified before-images, rollback, startup recovery and preserved external edits                                                          | `recovery.test.ts`, `storage.test.ts`, `source-migration.test.ts`        |

Publisher thumbnails or approved images can render with neutral local icon fallback.
Descriptions have recorded provenance; the app does not scrape full mod READMEs.
See the [content policy](content-policy.md) and [catalogue rules](../catalogue/README.md).

## Release evidence and remaining limits

`build-version.test.mjs`, `release.test.mjs` and `signing.test.mjs` verify assigned
versions, complete asset sets, checksums, signing reports, draft publication and
bounded retries for busy macOS DMG volumes. Browser and packaged startup tests check
the interface and runtime separately from real-game compatibility.

Windows has received the most complete manual testing. macOS, Linux and Steam Deck
still need native real-game feedback. Unfamiliar archive formats, unsupported version
constraints, native Linux LÖVE launching and ARM Linux remain outside automation.
Publisher signing, notarization and catalogue signatures are distinct claims;
a passing checksum or fixture test does not establish any of them.

Run the checks in [release verification](verification.md) and inspect current CI
results instead of relying on a historic test count.
