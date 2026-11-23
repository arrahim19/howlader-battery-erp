$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = (Get-Command node).Source
$localDirectory = Join-Path $projectRoot '.local/drive-server'
$serverReady = $false
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/v1/health' -TimeoutSec 3
  $serverReady = $health.data.status -eq 'ok'
} catch {}
if (-not $serverReady) {
  Start-Process -FilePath $runtime -ArgumentList @('"scripts/local-server.mjs"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localDirectory 'server.out.log') -RedirectStandardError (Join-Path $localDirectory 'server.err.log')
}
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri 'http://localhost:3000/login' -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { break }
  } catch {}
  Start-Sleep -Seconds 1
}
$edgePaths = @("${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe", "$env:ProgramFiles/Microsoft/Edge/Application/msedge.exe")
$edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge is required for the desktop app window.' }
Start-Process -FilePath $edge -ArgumentList @('--app=http://localhost:3000/dashboard', '--window-size=1366,900') -WindowStyle Normal
