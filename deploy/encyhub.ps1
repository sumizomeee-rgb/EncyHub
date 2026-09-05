[CmdletBinding()]
param(
    [ValidateSet("update", "restart", "sync-data", "show")]
    [string]$Action = "restart",
    [string]$TargetName
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$targetsPath = Join-Path $repoRoot ".local/deploy/targets.json"

if (-not (Test-Path -LiteralPath $targetsPath)) {
    throw "Missing local deployment config: $targetsPath. Copy deploy/targets.example.json first."
}

$targetsConfig = Get-Content -LiteralPath $targetsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $TargetName) {
    $TargetName = [string]$targetsConfig.default
}
if (-not $TargetName) {
    throw "No deployment target was selected."
}

$targetProperty = $targetsConfig.targets.PSObject.Properties[$TargetName]
if (-not $targetProperty) {
    throw "Unknown deployment target: $TargetName"
}
$target = $targetProperty.Value
$sshConfig = [string]$target.ssh_config
$sshTarget = [string]$target.ssh_target
$remoteRoot = [string]$target.remote_root
if (-not $sshConfig -or -not $sshTarget -or -not $remoteRoot) {
    throw "Target $TargetName must define ssh_config, ssh_target, and remote_root."
}
if ($remoteRoot.Contains("'")) {
    throw "remote_root must not contain a single quote."
}
if (-not (Test-Path -LiteralPath $sshConfig)) {
    throw "SSH config does not exist: $sshConfig"
}

function Invoke-Ssh([string]$RemoteCommand) {
    & ssh -F $sshConfig -o BatchMode=yes -o ConnectTimeout=10 $sshTarget $RemoteCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Remote command failed with exit code $LASTEXITCODE."
    }
}

function Invoke-Scp([string]$LocalPath, [string]$RemotePath) {
    & scp -F $sshConfig $LocalPath "${sshTarget}:$RemotePath"
    if ($LASTEXITCODE -ne 0) {
        throw "File sync failed: $LocalPath"
    }
}

if ($Action -eq "show") {
    [pscustomobject]@{
        name = $TargetName
        ssh_config = $sshConfig
        ssh_target = $sshTarget
        remote_root = $remoteRoot
    } | Format-List
    exit 0
}

$quotedRoot = "'$remoteRoot'"

if ($Action -eq "sync-data") {
    $files = @(
        "gm_console/custom_gm.json",
        "adb_master/config.json",
        "ios_master/config.json"
    )
    Invoke-Ssh "set -eu; mkdir -p $quotedRoot/.local/data/gm_console $quotedRoot/.local/data/adb_master $quotedRoot/.local/data/ios_master"
    foreach ($relativePath in $files) {
        $localPath = Join-Path $repoRoot ".local/data/$relativePath"
        if (Test-Path -LiteralPath $localPath) {
            Write-Host "Syncing $relativePath ..."
            Invoke-Scp $localPath "$remoteRoot/.local/data/$relativePath"
        } else {
            Write-Host "Skipping missing file: $localPath"
        }
    }
    Write-Host "[OK] Runtime user data synced."
    exit 0
}

Write-Host "[1/5] Updating EncyHub on $TargetName ..."
Invoke-Ssh "set -eu; git -C $quotedRoot pull --ff-only"
if ($Action -eq "update") {
    Write-Host "[OK] EncyHub source updated."
    exit 0
}

Write-Host "[2/5] Installing frontend dependencies and building ..."
Invoke-Ssh "set -eu; cd $quotedRoot; if [ -f frontend/package-lock.json ]; then npm --prefix frontend ci --include=optional --silent; else npm --prefix frontend install --silent; fi; npm --prefix frontend run build"

Write-Host "[3/5] Restarting Hub with systemd ..."
Invoke-Ssh "set -eu; systemctl --user restart encyhub.service; for i in `$(seq 1 30); do if curl -fsS 'http://127.0.0.1:9524/api/hub/tools' >/dev/null 2>&1; then exit 0; fi; sleep 1; done; echo '[ERROR] Hub did not recover in 30 seconds'; systemctl --user status encyhub.service --no-pager; exit 1"

Write-Host "[4/5] Ensuring GM Console is running ..."
Invoke-Ssh "set -eu; if ! curl -fsS 'http://127.0.0.1:9524/api/gm_console/' >/dev/null 2>&1; then curl -fsS -X POST 'http://127.0.0.1:9524/api/hub/tools/gm_console/start' >/dev/null || true; fi; for i in `$(seq 1 30); do if curl -fsS 'http://127.0.0.1:9524/api/gm_console/' >/dev/null 2>&1; then exit 0; fi; sleep 1; done; echo '[ERROR] GM Console did not recover in 30 seconds'; curl -fsS 'http://127.0.0.1:9524/api/hub/tools/gm_console' || true; exit 1"

Write-Host "[5/5] Verifying service, local data, and ports ..."
Invoke-Ssh "set -eu; systemctl --user is-active --quiet encyhub.service; test -d $quotedRoot/.local/data; curl -fsS 'http://127.0.0.1:9524/api/hub/tools/gm_console'; echo; ss -ltn 2>/dev/null | grep -E ':(9524|12581)[[:space:]]'"
Write-Host "[OK] $TargetName is updated; Hub and GM Console are running."
