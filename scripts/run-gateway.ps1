$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = 'C:\Program Files\nodejs\node.exe'
$entrypoint = Join-Path $projectRoot 'dist\index.js'
$dataDirectory = Join-Path $projectRoot '.data'

if (-not (Test-Path -LiteralPath $nodePath)) {
    throw "Node.js was not found at $nodePath"
}

if (-not (Test-Path -LiteralPath $entrypoint)) {
    throw "Browser Gateway is not built. Missing $entrypoint"
}

$token = [Environment]::GetEnvironmentVariable('BROWSER_GATEWAY_TOKEN', 'User')
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'The user-level BROWSER_GATEWAY_TOKEN environment variable is missing.'
}

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$env:BROWSER_GATEWAY_TOKEN = $token
$env:BROWSER_GATEWAY_HOST = '127.0.0.1'
$env:BROWSER_GATEWAY_PORT = '8788'
$env:BROWSER_GATEWAY_BROWSER_URL = 'http://127.0.0.1:9222'
$env:BROWSER_GATEWAY_DATA_DIR = $dataDirectory

Set-Location -LiteralPath $projectRoot
$process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList @($entrypoint) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dataDirectory 'service.stdout.log') `
    -RedirectStandardError (Join-Path $dataDirectory 'service.stderr.log') `
    -Wait `
    -PassThru
exit $process.ExitCode
