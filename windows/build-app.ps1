$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x C# compiler is required.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodePath -p 'process.versions.node'
$parsedVersion = [version]$nodeVersion
if (!(($parsedVersion.Major -eq 22 -and $parsedVersion -ge [version]'22.19.0') -or $parsedVersion.Major -ge 24)) { throw 'Node.js ^22.19.0 or >=24 is required.' }
Push-Location $repoRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Gateway build failed.' }
    # Unique output directories preserve previous builds and never delete user data.
    $output = Join-Path $PSScriptRoot ('build\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    $app = Join-Path $output 'WorkBuddy Model Bridge'
    New-Item -ItemType Directory -Path (Join-Path $app 'Gateway') -Force | Out-Null
    & $compiler /nologo /target:winexe /platform:anycpu /optimize+ /warnaserror+ "/out:$app\WorkBuddy Model Bridge.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'Bridge.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Windows app compilation failed.' }
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $app 'node.exe')
    Copy-Item -Path (Join-Path $repoRoot 'lib\*.js') -Destination (Join-Path $app 'Gateway')
    Set-Content -LiteralPath (Join-Path $app 'Gateway\package.json') -Value '{"type":"module"}' -Encoding ASCII
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE'), (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md') -Destination $app
    # Include notices for the exact bundled Node runtime.
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/v$nodeVersion/LICENSE" -OutFile (Join-Path $app 'NODE-LICENSE.txt')
    & $nodePath -p 'process.release' | Out-File (Join-Path $app 'node-runtime.txt')
    Compress-Archive -LiteralPath $app -DestinationPath (Join-Path $output 'WorkBuddy Model Bridge.zip')
    Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $app 'WorkBuddy Model Bridge.exe'), (Join-Path $output 'WorkBuddy Model Bridge.zip')
    Write-Output "Built Windows app: $app"
} finally { Pop-Location }
