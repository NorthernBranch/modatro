# Release signing

Modatro's macOS packaging signs the complete application bundle before creating its
DMG, then verifies nested code and sealed resources. A signature that fails validation
stops the build. Starting an unquarantined app on a build machine alone does not verify
that a downloaded app will pass Gatekeeper.

## macOS beta builds and public distribution

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
only to macOS packaging on trusted pushes or manual runs. Routine PR checks do not
package installers. The wrapper also strips credentials if invoked in a pull-request
environment. Automatic certificate discovery stays disabled, and every packaged app
must pass signature verification before upload.

Blank credentials are treated as absent. A partially configured setup fails
validation instead of silently falling back to ad-hoc signing.

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
The default direct electron-builder command remains an ad-hoc beta; use
`package:desktop` for credential-aware signing and distribution verification.

## Release evidence

Both macOS architectures retry packaging only when DMG creation reports an ejection
failure with `Resource busy`. There are at most three attempts, with five- and
ten-second delays before the retries. Signing, notarization and other failures stop
immediately. Signing reports are produced only after packaging and verification
succeed; an exhausted retry cannot publish a partial installer.

Each macOS build writes `signing-macos-arm64.json` or `signing-macos-x64.json` only
after verification passes. The report records the signing mode, notarization status,
installer filename and SHA-256 without including credentials. The release job checks
that each report matches its DMG before uploading or publishing. Release notes use
these reports instead of assuming every build has the same signing status.

`SHA256SUMS.txt` protects against mismatched or corrupted downloads when compared with
the release. Checksums and signing reports do not replace Apple's certificate chain
or notarization checks.

## Windows and Linux

Windows builds are unsigned because no publisher certificate or signing service is
configured. SmartScreen can warn or block them. A signing integration must sign and
timestamp both `Modatro.exe` and the NSIS installer, verify their Authenticode
signatures before upload, and report the actual signing status in release notes.

Possible integrations include Microsoft's
[Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
or an application to [SignPath Foundation](https://signpath.org/apply.html).
Check each service's eligibility and release requirements before configuring it.
Credentials must be restricted to trusted release jobs. Microsoft's
[SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
explains why signing does not immediately establish download reputation.

Linux downloads include release checksums. No package-repository or detached
publisher signature is currently configured.

See [Apple's Developer ID guidance](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/),
[Electron's macOS signing guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing#signing--notarizing-macos-builds)
and [Microsoft's Windows signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
