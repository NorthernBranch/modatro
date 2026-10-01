# Test fixtures

These fixtures provide game-folder and mod layouts for automated tests. The sample
`Balatro.exe` is a non-runnable text file with an `MZ` prefix; the support files are
placeholders. A real Balatro installation is not required.

Tests copy fixtures into temporary directories. Archive tests generate ZIPs with
traversal paths, symbolic links, duplicate entries, invalid size declarations and
corrupt checksums. Replacement tests write only to temporary game folders.

The mod fixtures cover standard and nested layouts, Lovely patches, explicit file
replacements and malformed metadata. They are test inputs, not installable mods.

See [Contributing](../CONTRIBUTING.md) for commands to run the test suites.
