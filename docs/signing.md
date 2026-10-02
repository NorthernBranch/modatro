# Release signing

Modatro's macOS packaging signs the complete application bundle before creating its
DMG, then verifies nested code and sealed resources. A signature that fails validation
stops the build. Starting an unquarantined app on a build machine alone does not verify
that a downloaded app will pass Gatekeeper.

## macOS previews and public distribution

Without Apple credentials, packages use an **ad-hoc signature**. This provides a
consistent resource seal and avoids retaining invalid signatures from Electron's
renamed runtime. It does not identify the publisher to Apple, permit notarization,
or guarantee that Gatekeeper will let a downloaded app open. Such packages are for
testing and remain explicitly labelled in release notes.

For normal internet distribution, sign with a **Developer ID Application** certificate
and notarize the app. This requires an Apple Developer Program membership. A Mac App
Store certificate, an Apple Development certificate, an ad-hoc signature and a
self-signed certificate do not substitute for that distribution certificate.

The signing configuration retains hardened runtime and Electron's JIT entitlement.
Only ad-hoc builds need the extra library-validation exception because their nested
Electron frameworks cannot share a Developer Team ID. Developer ID builds use the
narrower entitlement file. Electron renderer sandbox and context isolation remain
enabled in both modes.

## Configure GitHub Actions

Export the Developer ID Application certificate **with its private key** as a
password-protected `.p12` file. Add these repository Actions secrets:

| Secret                        | Value                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `MAC_CERTIFICATE_P12`         | Base64-encoded `.p12` containing certificate and private key |
| `MAC_CERTIFICATE_PASSWORD`    | Password protecting the `.p12`                               |
| `APPLE_ID`                    | Apple account used for notarization                          |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple account                 |
| `APPLE_TEAM_ID`               | Ten-character Apple Developer Team ID                        |

Use GitHub's secret settings; keep certificates, private keys and passwords out of
source control, issue reports and build artifacts. The workflow supplies credentials
only to macOS packaging on trusted pushes or manual runs. Pull-request builds use
ad-hoc signatures and do not receive signing credentials.

The packaging wrapper removes blank signing variables emitted by Actions before invoking
electron-builder. In particular, an empty `CSC_LINK` must be unset: electron-builder
otherwise interprets it as a certificate path resolving to the checkout directory.
Whitespace-only credentials are also absent; partial nonempty credentials still fail
configuration validation instead of silently changing signing modes.

The certificate is imported by electron-builder into its temporary signing keychain.
Packaging requires a matching Developer ID Application identity from the configured
team, signs the app and submits it to Apple's notary service. The returned ticket is
stapled to the app before the DMG is built. Verification requires `codesign --verify
--deep --strict`, the correct publisher/team, a valid stapled ticket and a successful
Gatekeeper assessment. Missing credentials in a partially configured setup, expired
certificates, rejected notarization or failed verification stop publication.

For local packaging, set electron-builder's equivalent environment variables:
`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`, then run:

```sh
pnpm build
pnpm package:desktop --mac --arm64 --x64
```

Do not put credential values directly in committed scripts or shell command examples.
The default direct electron-builder command remains an ad-hoc preview; use
`package:desktop` for credential-aware signing and distribution verification.

## Release evidence

Each macOS build writes `signing-macos-arm64.json` or `signing-macos-x64.json` only
after verification passes. The report records the signing mode, notarization status,
installer filename and SHA-256 without including credentials. The release job checks
that each report matches its DMG before uploading or publishing. Release notes use
these reports instead of assuming every build has the same signing status.

`SHA256SUMS.txt` protects against mismatched or corrupted downloads when compared with
the release. Checksums and signing reports do not replace Apple's certificate chain
or notarization checks.

## Windows and Linux

Windows EXE installers can be distributed unsigned, but SmartScreen can warn or block
them and show an unknown publisher. A trusted Authenticode signature is recommended
for public releases. Certificate or cloud-signing setup is separate from Apple's
process; signing alone does not guarantee immediate SmartScreen reputation. The
current workflow does not configure a Windows publisher-signing service.

Linux AppImage and directly downloaded DEB packages do not require an Apple-style
notarization service. A future signed package repository or detached release signature
can provide additional publisher verification. Current Linux downloads have release
checksums and do not claim a publisher signature.

See [Apple's Developer ID guidance](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/),
[Electron's macOS signing guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing#signing--notarizing-macos-builds)
and [Microsoft's Windows signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
