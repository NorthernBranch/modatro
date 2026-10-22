# Test fixtures

These fixtures provide game-folder and mod layouts for automated tests. The sample
`Balatro.exe` is a non-runnable text file with an `MZ` prefix; the support files are
placeholders. A real Balatro installation is not required.

Tests copy fixtures into temporary directories. Archive tests generate ZIPs with
traversal paths, symbolic links, duplicate entries, invalid size declarations and
corrupt checksums. Replacement tests write only to temporary game folders.

The mod fixtures cover standard and nested layouts, Lovely patches, explicit file
replacements and malformed metadata. They are test inputs, not installable mods.
Creator tests generate PNGs and Lua in temporary projects and exercise builds,
installation, restoration and rollback. A test-only Lua VM checks generated code
against mocked game APIs. User-written Lua is parsed without execution, and tests
do not launch a real game.

Generated tests also cover release wrappers with outer Lovely error patches,
dependency batches, native Lovely library evidence, and Balatro's `version.jkr`
inside ZIP game data. Keep all filesystem operations inside temporary fixtures.

README screenshots are captured separately by `scripts/screenshots.mjs` using the
real renderer and representative data from `src/preview-catalogue.json`. They do
not use real game folders or application records. See the contributor guide for
regeneration instructions.

See [Contributing](../CONTRIBUTING.md) for commands to run the test suites.
