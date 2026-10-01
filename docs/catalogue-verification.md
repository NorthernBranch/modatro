# Catalogue and installation hardening coverage

This guide describes the implemented catalogue boundaries and their verification.
It does not certify third-party mods as safe or establish author permission without
human review. The existing desktop architecture and transactional installer remain
in use.

| Requirements              | Behavior                                                                                                                                                                                                                          | Evidence                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1–3, 18–22, 36–37, 49, 53 | Direct upstream downloads; separate consent; author ownership; independent branding; submission and removal process; licence metadata is informational                                                                            | README, About, content policy, issue forms, catalogue contribution rules        |
| 4–6, 25–29                | Independent append-only restriction feeds supersede saved catalogues; individual versions can be blocked; existing copies remain unchanged; unavailable sources pause updates                                                     | `trust.test.ts`, `ui-requests.spec.ts`, `download.test.ts`                      |
| 7–9                       | Matching assets and tags preferred, branch archives pinned where possible, mutable sources identified, exact archive provenance/hash history persisted; changed immutable content stops automation                                | `trust.test.ts`, `artifacts.ts`, `distribution.ts`                              |
| 10–12, 24, 30–32          | No downloaded installers/scripts executed; unsupported methods fail safely; separate install/update permission; actual game-file plan confirmation and optional plan inspection; original-file and ownership protections retained | `trust.test.ts`, `installer.test.ts`, `recovery.test.ts`                        |
| 13–15, 38, 45–46, 48      | Author manifests, native compiled index, provider abstraction, stable IDs and legacy aliases; schema/path/URL/identity/version validation in catalogue CI                                                                         | `catalogue-schema.ts`, catalogue compiler, `catalogue.test.ts`, `trust.test.ts` |
| 16–17, 34–35              | Unapproved legacy descriptions omitted, no README scraping or copied artwork, neutral icon cards, modest provenance labels and third-party-code disclaimer                                                                        | `ui-requests.spec.ts`, `ModArt.tsx`, content policy                             |
| 23, 33, 44                | Dependency source/hash records; library format and embedded identity evidence; source/strategy/file/transaction audit logging with home-directory redaction                                                                       | `local-mods.test.ts`, `installer.ts`, `storage.ts`                              |
| 26–29, 39–40              | Offline local operations and installed visibility; source disappearance preserves copies; backed-up schema migration preserves ownership and honest missing provenance                                                            | `external-mods.test.ts`, `trust.test.ts`, `storage.test.ts`                     |
| 41–43                     | Validated IPC and secure URL allowlist, every redirect checked, destination containment, symlink/ZIP traversal/CRC/decompression protections                                                                                      | `desktop.spec.ts`, `archive.test.ts`, `download.test.ts`                        |
| 47                        | Signature verification boundary and key/expiry/rollback design documented; catalogue signatures are a future hardening step                                                                                                       | Catalogue contribution guide, native provider verifier                          |
| 50–52                     | Regression coverage for each requested safety scenario; normal standard installs remain one-click, with details and interruptions reserved for actionable problems                                                                | Backend and UI suites listed above                                              |
| External installations    | Metadata-identified folders and Lua files can be adopted explicitly, even without a catalogue entry; unknown/duplicate copies stay external; added and changed files are protected                                                | `external-mods.test.ts`, `local-mods.test.ts`, `ui-requests.spec.ts`            |
| Linux distribution        | x64 AppImage and DEB builds; Steam/Flatpak discovery and Proton prefix integration; Linux CI runtime checks configured                                                                                                            | `external-mods.test.ts`, release workflow, Linux guide                          |

Catalogue and restriction feeds are currently authenticated by HTTPS and their
maintained GitHub source, not cryptographic signatures. Native listing approval and
licence evidence still require maintainer review. The native catalogue starts empty
so examples cannot accidentally become approved listings; legacy discovery remains
available through its separate provider. The new endpoints become available when
the catalogue files are pushed to the configured repository.

Automatic downloads support approved GitHub hosts. Other author endpoints can be
described but require manual installation until a reviewed transport adapter supports
them. Approved artwork is not fetched by the current renderer; neutral local icons
remain the fallback. Native Linux LÖVE launch and ARM Linux are outside this integration.
Real Steam Deck, Windows and Intel Mac game compatibility require native testing.
