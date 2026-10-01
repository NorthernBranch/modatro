# Modatro catalogue

This directory is a first-party GitHub-hosted index, with no custom server. It can
also be maintained in a standalone index repository. The desktop application combines
its compiled entries with the archived Balatro Mod Index provider.

```text
mods/<author>/<slug>/meta.json
index.json
revocations.json
blocked-releases.json
schema/*.schema.json
```

`index.json` is generated discovery metadata, not a mirror of mod archives. Prefer
an author-controlled `modatro.json` for installation metadata. The author manifest
must live in the declared repository and retain its indexed identity and repository.
The index and manifest permissions are intersected; neither can widen the other's
restrictions. See [the manifest example](../examples/modatro.json).

## Submitting a mod

Use [Submit a mod](https://github.com/NorthernBranch/modatro/issues/new?template=mod-submission.yml)
or submit a pull request containing `mods/<author>/<slug>/meta.json`. Submission requires
confirmation that:

1. You are the author or have permission to submit the mod.
2. You permit display of the submitted discovery metadata.
3. You permit Modatro to direct users to and download from the configured source.
4. You have the right to supply each description and image for catalogue display.
5. You can request removal later.
6. Modatro does not take ownership of the mod or require a copyright transfer.

Third-party submissions require evidence of permission or a reviewed licence that
permits the intended uses. A public GitHub repository alone is not permission.
Maintainers record that evidence in `approvalEvidence`; do not mark an entry
`author-approved` merely because somebody submitted it. Licence interpretation is
reviewed by people; the validator does not make legal determinations.

Native IDs are stable `author/slug` identities, independent of the display title.
Use `metadataId` for the mod's actual loader identity and `legacyIds` to connect
previous index IDs. Existing installation IDs and file ownership remain intact
when an approved native entry replaces a legacy entry.

Every published entry needs an explicit approval status and separate `display`,
`install` and `update` permissions. A missing approval status defaults to pending
review. Use the runtime/generated schemas for supported fields. Keep descriptions
short and identify `descriptionProvenance` as `author-supplied`, `licensed` or `factual`.
Supply `iconUsageApproved` and permission evidence before including `iconUrl`.

## Validation and publication

```sh
pnpm catalogue:build
pnpm catalogue:check
pnpm check
```

Commit the compiled `index.json` and schemas along with the source changes. CI rejects
invalid schema, duplicate IDs/aliases, directory/ID mismatches, insecure or unsupported
URLs, unsafe destinations, unsupported strategies and invalid version ranges. It
warns about moving branch sources, missing licence information, absent approval
status and missing supplied checksums. Manifests use structured installation methods;
downloaded installers and shell scripts are never executed by Modatro.

The application reads the compiled catalogue and independent restriction feeds over
HTTPS. The default endpoints are in this repository's `main/catalogue/` directory;
they become available after these files are pushed. The native provider's endpoint
is injectable, so a standalone repository can supply the same contract. Do not ship
an unreviewed example as a real mod listing.

## Fast removal and release blocking

For a verified author request, append an entry to `revocations.json`:

```json
{
  "modId": "author/mod-slug",
  "repositoryUrl": "https://github.com/author/mod-slug",
  "reason": "author-request",
  "effectiveAt": "2026-10-01T12:00:00Z"
}
```

Increase the feed's `revision`, update `generatedAt`, compile and validate, then merge
the change. Include the source repository to cover known aliases. Removals are
append-only: clients retain previously seen revocations, reject older revisions and
never interpret an omitted entry as reinstatement. Other reasons include `malware`,
`compromised-release`, `invalid-source`, `licensing`, `broken-install`, `security-risk`
and `other`.

For one release, append `{ "modId": "author/mod-slug", "version": "1.4.2",
"status": "blocked", "reason": "Known broken release", "effectiveAt": "2026-10-01T12:00:00Z" }`
to `blocked-releases.json` and increase that feed's revision. Publish a separate safe
version rather than replacing a flagged artifact. Existing user files are unaffected.

## Future catalogue signing

Catalogue signatures are not implemented yet. The native provider exposes a verifier
boundary before schema parsing, allowing a signed envelope without changing the
installer. A future implementation should verify canonical payloads and both
restriction feeds against keys shipped with the application, enforce expiry and
revision rollback checks, and support deliberate key rotation. Keys supplied only by
the downloaded catalogue must not become trust anchors.
