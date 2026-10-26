#requires -Version 5.1
. (Join-Path $PSScriptRoot 'common.ps1')
if (Test-PostgresRunning) {
  $result = Invoke-PostgresProgram 'pg_ctl' @('stop', '-D', $script:PostgresData, '-m', 'fast', '-w', '-t', '30')
  if ($result.ExitCode -ne 0) { throw 'PostgreSQL could not complete a clean shutdown. No files were deleted.' }
}
Write-Host 'Project-local PostgreSQL is stopped. Existing data is preserved.'
