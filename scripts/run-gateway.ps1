#Requires -Version 5.1
<#
.SYNOPSIS
    Windows convenience launcher for the Browsergator gateway.
.DESCRIPTION
    Delegates to the portable Node launcher (scripts/run-gateway.mjs) so there is a
    single source of truth and no hardcoded interpreter path. Node is resolved from
    PATH, so this works with system installs, nvm4w, fnm, winget, and Scoop.

    Configuration/secrets come from the ambient environment or a project-root .env
    file (loaded by the gateway). This script no longer reads a Windows User-scope
    registry variable and no longer hardcodes C:\Program Files\nodejs\node.exe.
.EXAMPLE
    ./scripts/run-gateway.ps1
    ./scripts/run-gateway.ps1 --dev
#>
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw "Node.js was not found on PATH. Install Node 22.12+ (system, nvm4w, fnm, winget, or Scoop)."
}

$launcher = Join-Path $PSScriptRoot 'run-gateway.mjs'
& $node.Source $launcher @args
exit $LASTEXITCODE
