param([Parameter(Mandatory = $true)][string]$AppPath)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testExe = Join-Path (Split-Path (Resolve-Path -LiteralPath $AppPath) -Parent) 'SmokeTests.exe'
& $compiler /nologo /target:exe /warnaserror+ "/out:$testExe" /reference:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'SmokeTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Smoke test compilation failed.' }
& $testExe $AppPath (Get-Command node.exe).Source
if ($LASTEXITCODE -ne 0) { throw 'Smoke tests failed.' }
