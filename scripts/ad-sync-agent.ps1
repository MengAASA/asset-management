<#
.SYNOPSIS
  PHN IAMS - on-demand Active Directory sync agent.

.DESCRIPTION
  Runs on an internal, domain-joined Windows server. It waits for "Sync from AD"
  requests from the asset management app (outbound HTTPS long-poll), reads users
  from AD when one arrives and pushes them back. Nothing connects into the network.

  Task Scheduler starts this script every minute; each run listens for ~55 seconds.

.PARAMETER Install
  Registers the "PHN IAMS AD Sync Agent" scheduled task (run from an elevated PowerShell).

.PARAMETER Uninstall
  Removes the scheduled task.

.PARAMETER Test
  Checks the app connection and the AD query, then exits without pushing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\PHNIAMS\ad-sync-agent.ps1 -Test
  powershell -ExecutionPolicy Bypass -File C:\PHNIAMS\ad-sync-agent.ps1 -Install
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Test
)

# ============================== Settings ==============================

# App URL including the /phniams base path, no trailing slash
$ServerUrl  = "http://localhost:3001/phniams"
# $ServerUrl  = "https://forma.phn.com.my/phniams" live

# Generated in the app under Settings -> AD Sync Agent
# $ApiKey     = "PASTE-AGENT-KEY-HERE"
# $ApiKey     = "Uf0CKmxDea4Z1XMuXydiwTgR1al-nxdYdnRU1lU3vQk" live
$ApiKey     = "wVBSuj26-hLICCNwM4o0__4FHW51wAZwzPRn-tQIasw"

# Where to search for users. Blank = the whole domain. e.g. "OU=Staff,DC=phn,DC=local"
$SearchBase = ""

# Enabled person accounts that have an email address
$UserFilter = "(&(objectClass=user)(objectCategory=person)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(mail=*))"

# How long each scheduled run keeps listening (the task restarts every minute)
$RunSeconds = 55

$TaskName   = "PHN IAMS AD Sync Agent"
$LogFile    = Join-Path $PSScriptRoot "ad-sync-agent.log"

# ======================================================================

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) {
      Move-Item $LogFile "$LogFile.old" -Force
    }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
}

function Get-Prop($Result, [string]$Name) {
  $values = $Result.Properties[$Name.ToLower()]
  if ($values -and $values.Count -gt 0) { return [string]$values[0] }
  return ""
}

function New-Searcher([string]$Filter, [string[]]$Properties, [string]$Base) {
  $root = if ($Base) { New-Object DirectoryServices.DirectoryEntry("LDAP://$Base") } else { New-Object DirectoryServices.DirectoryEntry }
  $searcher = New-Object DirectoryServices.DirectorySearcher($root)
  $searcher.Filter = $Filter
  $searcher.PageSize = 1000
  $searcher.SearchScope = "Subtree"
  $Properties | ForEach-Object { [void]$searcher.PropertiesToLoad.Add($_) }
  return $searcher
}

# Computers with managedBy set -> map of user DN (lowercase) to computer names
function Get-DeviceMap {
  $map = @{}
  try {
    $searcher = New-Searcher "(&(objectClass=computer)(managedBy=*))" @("cn", "dnshostname", "managedby") ""
    foreach ($r in $searcher.FindAll()) {
      $owner = (Get-Prop $r "managedBy").ToLower()
      $name = Get-Prop $r "cn"
      if (-not $name) { $name = Get-Prop $r "dNSHostName" }
      if (-not $owner -or -not $name) { continue }
      if (-not $map.ContainsKey($owner)) { $map[$owner] = New-Object System.Collections.Generic.List[string] }
      $map[$owner].Add($name)
    }
  } catch {
    # Device lookup is best-effort - don't fail the whole sync if this errors
    Write-Log "Device lookup failed: $($_.Exception.Message)"
  }
  return $map
}

function Get-ADUsersForSync {
  $deviceMap = Get-DeviceMap
  $props = @("distinguishedName", "sAMAccountName", "displayName", "cn", "mail", "userPrincipalName", "title",
             "department", "telephoneNumber", "mobile", "manager", "description", "physicalDeliveryOfficeName")
  $searcher = New-Searcher $UserFilter $props $SearchBase

  $users = New-Object System.Collections.Generic.List[object]
  foreach ($r in $searcher.FindAll()) {
    $dn = Get-Prop $r "distinguishedName"
    $name = Get-Prop $r "displayName"; if (-not $name) { $name = Get-Prop $r "cn" }
    $email = Get-Prop $r "mail"; if (-not $email) { $email = Get-Prop $r "userPrincipalName" }
    $phone = Get-Prop $r "telephoneNumber"; if (-not $phone) { $phone = Get-Prop $r "mobile" }

    # The manager attribute holds a DN - keep just the CN
    $managerDN = Get-Prop $r "manager"
    $manager = if ($managerDN) { ($managerDN -split ",")[0] -replace "^cn=", "" } else { "" }

    $devices = if ($deviceMap.ContainsKey($dn.ToLower())) { $deviceMap[$dn.ToLower()].ToArray() } else { @() }

    $users.Add([pscustomobject]@{
      dn              = $dn
      sAMAccountName  = Get-Prop $r "sAMAccountName"
      displayName     = $name
      email           = $email
      jobTitle        = Get-Prop $r "title"
      department      = Get-Prop $r "department"
      phone           = $phone
      manager         = $manager
      office          = Get-Prop $r "physicalDeliveryOfficeName"
      description     = Get-Prop $r "description"
      assignedDevices = $devices
    })
  }
  return ,$users.ToArray()
}

function Invoke-App([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutSec = 60) {
  $params = @{
    Uri             = "$ServerUrl$Path"
    Method          = $Method
    Headers         = @{ "X-Agent-Key" = $ApiKey }
    TimeoutSec      = $TimeoutSec
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $json = ConvertTo-Json -InputObject $Body -Depth 5 -Compress
    $params.Body = [Text.Encoding]::UTF8.GetBytes($json)
    $params.ContentType = "application/json; charset=utf-8"
  }
  return Invoke-RestMethod @params
}

function Get-StatusCode($ErrorRecord) {
  $response = $ErrorRecord.Exception.Response
  if ($response) { return [int]$response.StatusCode }
  return 0
}

function Invoke-SyncRequest([string]$RequestId) {
  $started = Get-Date
  try {
    $users = Get-ADUsersForSync
  } catch {
    $message = "AD query failed: $($_.Exception.Message)"
    Write-Log "Request $RequestId - $message"
    try { Invoke-App "POST" "/api/ad/agent/push" @{ requestId = $RequestId; error = $message } | Out-Null } catch { }
    return
  }

  try {
    $result = Invoke-App "POST" "/api/ad/agent/push" @{ requestId = $RequestId; users = $users }
    $secs = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Write-Log "Request $RequestId - pushed $($result.received) users in ${secs}s"
  } catch {
    Write-Log "Request $RequestId - push failed: $($_.Exception.Message)"
  }
}

# ------------------------------ Install / Uninstall ------------------------------

if ($Install) {
  $scriptPath = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$scriptPath`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1)
  # SYSTEM on a domain-joined server reads AD as the computer account - no password stored
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description "Answers on-demand AD sync requests from PHN IAMS." -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Scheduled task '$TaskName' installed and started."
  exit 0
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Scheduled task '$TaskName' removed."
  exit 0
}

if ($ApiKey -eq "PASTE-AGENT-KEY-HERE" -or $ServerUrl -like "*your-vps-domain*") {
  Write-Log "Edit `$ServerUrl and `$ApiKey at the top of the script first."
  exit 1
}

# ------------------------------ Test ------------------------------

if ($Test) {
  Write-Host "Checking connection to $ServerUrl ..."
  try {
    Invoke-App "GET" "/api/ad/agent/poll?wait=1" | Out-Null
    Write-Host "  OK - app reachable and agent key accepted."
  } catch {
    $code = Get-StatusCode $_
    if ($code -eq 401) { Write-Host "  FAILED - agent key rejected. Generate a new one in Settings -> AD Sync Agent." }
    else { Write-Host "  FAILED - $($_.Exception.Message)" }
  }

  Write-Host "Querying Active Directory ..."
  try {
    $users = Get-ADUsersForSync
    $withDept = @($users | Where-Object { $_.department }).Count
    Write-Host "  OK - $($users.Count) users found ($withDept with a department; only those are shown in the app)."
    $users | Select-Object -First 5 displayName, email, department | Format-Table -AutoSize
  } catch {
    Write-Host "  FAILED - $($_.Exception.Message)"
  }
  exit 0
}

# ------------------------------ Listen loop ------------------------------

$deadline = (Get-Date).AddSeconds($RunSeconds)
while ($true) {
  $remaining = [int][math]::Floor(($deadline - (Get-Date)).TotalSeconds)
  if ($remaining -lt 1) { break }
  $wait = [math]::Min($remaining, 25)

  try {
    $resp = Invoke-App "GET" "/api/ad/agent/poll?wait=$wait" -TimeoutSec ($wait + 20)
  } catch {
    if ((Get-StatusCode $_) -eq 401) {
      Write-Log "Agent key rejected by the app. Update `$ApiKey with the key from Settings -> AD Sync Agent."
      exit 1
    }
    Write-Log "Poll failed: $($_.Exception.Message)"
    Start-Sleep -Seconds 5
    continue
  }

  if ($resp.requestId) {
    Write-Log "Request $($resp.requestId) received"
    Invoke-SyncRequest $resp.requestId
  }
}
