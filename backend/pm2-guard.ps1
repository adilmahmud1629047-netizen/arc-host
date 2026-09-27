# FLARE Hosting - PM2 resurrection guard
# Runs at system startup and user logon. If the production app is NOT
# listening on port 5000 (fresh boot / PM2 daemon gone), restore it from
# the saved PM2 process list (pm2 save). Does nothing when the app is up.
$ErrorActionPreference = 'SilentlyContinue'
$pm2 = Join-Path $env:APPDATA 'npm\pm2.cmd'
$listening = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    & $pm2 resurrect
}
exit 0
