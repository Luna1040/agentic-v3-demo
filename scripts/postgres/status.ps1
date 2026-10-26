#requires -Version 5.1
. (Join-Path $PSScriptRoot 'common.ps1')
$running = Test-PostgresRunning
[ordered]@{ version = $script:PgVersion; running = $running; host = $script:PgHost; port = $script:PgPort; dataDirectory = $script:PostgresData } | ConvertTo-Json -Compress
