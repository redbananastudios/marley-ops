# Nightly Marley Ops prod backup — pg_dump via SSH on vps1 (self-hosted Supabase).
# The prod DB is the supabase-db container on vps1 (no public 5432; Hetzner firewall
# allows 22/80/443 only), so the dump runs inside the container over SSH and streams
# back to i9. Dumps land in the backups folder (rides Google Drive off-machine),
# pruned after 30 days, size logged so growth is visible.
# Schedule silently via the VBS-launcher pattern (make-tasks-silent.ps1).

$ErrorActionPreference = "Stop"
$sshKey = "C:\Users\peter\.ssh\rbs_vps"
$vpsHost = "root@178.105.182.36"
$backupDir = "O:\projects\red-banana\clients\marley\backups"
$logFile = Join-Path $backupDir "backup.log"

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Force $backupDir | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$outFile = Join-Path $backupDir "marley-ops-$stamp.sql"

# --no-owner/--no-privileges: logical dump restorable into any Postgres.
# Public schema only would lose auth.users (logins) — dump the whole database.
# Git Bash ssh, NOT Windows OpenSSH: the Windows one hard-rejects the key/config
# ACLs (CodexSandboxUsers ACE on ~/.ssh); Git's ssh doesn't enforce Windows ACLs.
$sshExe = "C:\Program Files\Git\usr\bin\ssh.exe"
& $sshExe -F /dev/null -i $sshKey -o BatchMode=yes -o StrictHostKeyChecking=accept-new $vpsHost "docker exec supabase-db pg_dump -U postgres -d postgres --no-owner --no-privileges" | Out-File -FilePath $outFile -Encoding utf8
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outFile) -or (Get-Item $outFile).Length -lt 10240) {
    Add-Content $logFile "$(Get-Date -Format s) FAIL dump missing/too small (ssh exit $LASTEXITCODE)"
    exit 1
}

# Compress + remove the raw dump.
Compress-Archive -Path $outFile -DestinationPath "$outFile.zip" -Force
Remove-Item $outFile -Confirm:$false

# Prune > 30 days.
Get-ChildItem $backupDir -Filter "marley-ops-*.zip" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Confirm:$false

$size = [math]::Round((Get-Item "$outFile.zip").Length / 1MB, 2)
Add-Content $logFile "$(Get-Date -Format s) OK marley-ops-$stamp.sql.zip ($size MB)"
