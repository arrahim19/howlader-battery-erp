$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/v1/health' -TimeoutSec 3
  if ($health.data.status -eq 'ok') { exit 0 }
} catch {}
$runtime = (Get-Command node).Source
$localDirectory = Join-Path $projectRoot '.local/drive-server'
Start-Process -FilePath $runtime -ArgumentList @('"scripts/local-server.mjs"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localDirectory 'server.out.log') -RedirectStandardError (Join-Path $localDirectory 'server.err.log')
