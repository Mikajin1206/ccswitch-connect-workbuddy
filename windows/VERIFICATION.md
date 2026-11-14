# Windows verification

Branch: `feat/windows-native-app`. Target: portable native Windows app with the same shared gateway as the macOS app. Assumption: Windows 10/11 with .NET Framework 4.8; bundled Node architecture follows the build machine (x64 here). No installer, signing, publishing, or deployment.

## Commands and results

- Before changes: `npm.cmd run typecheck` — PASS.
- After changes: `npm.cmd run typecheck`, `npm.cmd run build`, `npm.cmd run check:pii` — PASS.
- Native compiler: `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /platform:anycpu /optimize+ /warnaserror+ /out:<output.exe> /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll <absolute-path-to-Bridge.cs>` — PASS.
- Compile `SmokeTests.cs` with the same compiler, `/target:exe /warnaserror+ /reference:System.Windows.Forms.dll`, then run `SmokeTests.exe <absolute-app-path> <node.exe>` — PASS: readiness validation, both regional panels, managed child shutdown, close-to-tray. Tests instantiate a hidden form and use a mock Node child; no production gateway is started.
- `build-app.ps1` and `test-app.ps1` — parsed with PowerShell AST. Direct script execution was blocked by host execution policy. No execution-policy settings changed; equivalent compilation and packaging commands were run directly in the terminal. Initial compiler invocation with a relative forward-slash path failed; absolute source paths compiled successfully.
- `Compress-Archive` produced `windows/build/WorkBuddy-Model-Bridge-windows-verification.zip`, containing EXE, Node, gateway, module metadata and licenses. Build output is ignored by Git.
- EXE SHA256: `6F510FFD4D0E7FD7061572E1E51FBF1CB5487DE20E58ACB6DB1AB74B0D721863`.
- ZIP SHA256: `E1407B342E1052E64BAEC91E37A1CB0D524A5838FFE25A03CC53426642185588`.

## Coverage and limits

Changed files: `.gitignore`, `README.md`, `README.en.md`, `src/mac-gateway.ts`, and the Windows shell/build/test/verification files in this directory. Existing untracked `package-lock.json` is excluded from the commit. Existing hub workspace changes were left untouched.

No real account tokens, persistent API keys or credential directories were accessed during tests. No ACL changes, service stops, permission changes, paid services or external messages were performed. Publishing the requested branch and PR is the only repository write outside the workspace. Real WorkBuddy login, upstream inference, clipboard interaction and tray interaction in an interactive desktop remain unverified. Existing credential code hardens Windows vault ACLs at runtime; testing against real credentials or running that behavior requires separate approval under the task's permission-change rule.

Implementation references: Microsoft [DPAPI CurrentUser](https://learn.microsoft.com/en-us/dotnet/standard/security/how-to-use-data-protection) and [NotifyIcon](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/notifyicon-component-overview-windows-forms). The build downloads the matching Node release license from the official `nodejs/node` repository and includes it in the portable package.
