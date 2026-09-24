# Dev-mode wiring: let DSH Desktop load this repo's study host plugin.
#
# PREFER THE BUNDLE INSTALL INSTEAD
#   This package IS a DSH bundle (package.json declares dsh.bundle.patch), so the
#   supported install is:
#       dsh plugin --profile web add dsh-study-alongwith-ai
#   That route needs no junction and no hand-written profile patch, and it also
#   publishes the study preset through the bundle patch. Use THIS script only
#   when developing this repo and you want live edits without repackaging.
#
#   Both routes must never be active at once: each inserts a row with the same
#   id, which mounts the plugin twice and opens the storage domain twice. That is
#   exactly the failure this repo already hit once. The script below detects an
#   installed bundle and refuses to write the dev patch when it finds one.
#
# WHY THE JUNCTION IS NEEDED (dev route only)
#   The plugin's peer deps (@deepseek-ai/*, zod) live in the DSH profile.
#   Node resolves node_modules by walking up from the *importing file*, and this
#   repo lives elsewhere, so a junction inside the repo points at the profile's
#   node_modules to make those peers resolvable.
#
# USAGE  (works on Windows PowerShell 5.1 and PowerShell 7)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-link.ps1
#       -> creates the junction and prints the YAML you must paste
#   ... -Write    also writes the profile's cordis.patch.yml, but ONLY when empty
#   ... -Force    with -Write: replace existing active entries; also allows
#                 writing the dev patch while a bundle install is present
#   ... -Remove   removes the junction
#
# NOTE
#   This script is intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1
#   files as ANSI unless they carry a UTF-8 BOM, so non-ASCII text here would be
#   mis-decoded and break parsing. Chinese explanations live in README.md.
#   The junction is machine-local; .gitignore excludes it.

[CmdletBinding()]
param(
  [string]$ProfileName = 'web',
  # Do NOT compute this in the param default: $PSScriptRoot is still empty while
  # binding parameters under -File, which throws "Cannot bind argument to
  # parameter 'Path' because it is an empty string".
  [string]$RepoRoot = '',
  [switch]$Write,
  [switch]$Force,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
}
if (-not (Test-Path $RepoRoot)) {
  Write-Error "Repo root not found: $RepoRoot. Pass -RepoRoot <path> explicitly."
}
$RepoRoot = (Resolve-Path $RepoRoot).Path

$harness = Join-Path $env:APPDATA 'dsh-desktop\harness'
$profileDir = Join-Path $harness "profiles\$ProfileName"
$profileModules = Join-Path $harness 'profiles\node_modules'
$linkPath = Join-Path $RepoRoot 'node_modules'
$entry = Join-Path $RepoRoot 'packages\plugin-host\src\index.ts'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

# Does this profile already load us as a bundle? Read dsh.profile.bundles from the
# profile manifest - that list is the authority the loader reconciles against.
$profileManifest = Join-Path $profileDir 'package.json'
$bundleInstalled = $false
if (Test-Path $profileManifest) {
  try {
    $manifest = Get-Content $profileManifest -Raw | ConvertFrom-Json
    $bundleInstalled = @($manifest.dsh.profile.bundles) -contains 'dsh-study-alongwith-ai'
  } catch {
    Write-Warning "Could not parse $profileManifest - assuming no bundle install."
  }
}

Write-Host '=== study-alongwith-AI / dev-mode wiring ==='
Write-Host "DSH_HOME     : $harness"
Write-Host "profile dir  : $profileDir"
Write-Host "plugin entry : $entry"
Write-Host "bundled      : $bundleInstalled"
Write-Host ''

if (-not (Test-Path $profileDir)) {
  Write-Error "Profile directory not found: $profileDir`nStart DSH Desktop at least once; it creates profiles\$ProfileName."
}
if (-not (Test-Path $entry)) {
  Write-Error "Plugin entry not found: $entry`nRun this script from the repository root."
}

if ($Remove) {
  $pairs = @(@{ Link = $linkPath; Label = 'node_modules' })
  # 每个 preset 目录一条（本仓库会有多个模式：study / socratic / …）
  $presetRootForRemove = Join-Path $harness '.agent-presets'
  $presetSourceRoot = Join-Path $RepoRoot 'presets'
  if (Test-Path $presetSourceRoot) {
    foreach ($dir in Get-ChildItem $presetSourceRoot -Directory) {
      $pairs += @{ Link = (Join-Path $presetRootForRemove $dir.Name); Label = "preset $($dir.Name)" }
    }
  }
  foreach ($pair in $pairs) {
    $target = $pair.Link
    if (Test-Path $target) {
      $item = Get-Item $target -Force
      if ($item.LinkType) {
        # 旧版用 junction 建过；junction 对预设发现无效（见下面 1b 的说明），移除它
        cmd /c rmdir "$target"
        Write-Host "Removed $($pair.Label) junction: $target"
      } elseif ($pair.Label -like 'preset *') {
        # 预设副本是本脚本放的，可以安全删除；node_modules 的真实目录不动
        Remove-Item $target -Recurse -Force
        Write-Host "Removed $($pair.Label) copy: $target"
      } else {
        Write-Warning "$target is a real directory (not created by this script); left untouched."
      }
    } else {
      Write-Host "Nothing to remove for $($pair.Label)."
    }
  }
  return
}

# -- 1. junction so the plugin's peer deps resolve ----------------------------
if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  Write-Host "Already present: $linkPath (LinkType=$($item.LinkType)) - skipping."
  if ($item.LinkType -ne 'Junction') {
    Write-Warning 'It is not a junction. If it is a real directory, peer resolution may still fail.'
  }
} elseif (-not (Test-Path $profileModules)) {
  Write-Warning "Not found: $profileModules - cannot create the junction. Peer resolution will likely fail."
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $profileModules | Out-Null
  Write-Host "Created junction: $linkPath -> $profileModules"
}

# -- 1b. junction every preset into the user preset root ----------------------
# dsh-agent-presets owns `<DSH_HOME>/.agent-presets` as the writable root for
# locally authored presets (one directory per preset, identified by carrying
# `agent.cordis.yml`). A junction there makes repo edits take effect at once:
# discovery re-reads its roots on every call.
#
# 遍历 `presets/*` 而不是只链 study：DSH 的 scanRoot() 把 root 下每个匹配
# /^[a-z0-9][a-z0-9-]*$/ 的子目录当成一个 preset，所以新增模式必须一起处理。
#
# ⚠️⚠️ 为什么这里用**复制真实目录**而不是 junction（2026-09-28 实测根因）：
#   DSH 的 `scanRoot()`（`dsh-agent-presets/lib/index.js:403`）判断标准是
#       `if (!child.isDirectory() || !PRESET_ID.test(child.name)) continue`
#   而 Windows 上 **junction 被 Node 的 readdir(withFileTypes) 报成 symbolic link**：
#       socratic | dirent.isDirectory= false | dirent.isSymbolicLink= true | statSync.isDirectory= true
#   → **junction 会被直接跳过**，模式在「模式选择器」里根本不出现（study 与 socratic 都一样）。
#   因此开发路线必须放**真实目录副本**。
#
#   代价：改 `presets/` 里的文件后，要重跑本脚本把副本刷新一遍（预设文件很少变动，可接受）。
#   注意：这只影响"模式本身（persona/技能）"的开发；插件代码（packages/）仍由上面的 junction 热重载。
$presetRoot = Join-Path $harness '.agent-presets'
$presetSource = Join-Path $RepoRoot 'presets'

if ($bundleInstalled) {
  # The bundle patch publishes <package>/presets as a system-trust root, and
  # discovery is first-root-wins per id (shipped, then config.roots, then user),
  # so a user-root copy here would be shadowed anyway. Skip it.
  Write-Host 'Bundle install detected - skipping the preset copies.'
} elseif (-not (Test-Path $presetSource)) {
  Write-Warning "No presets directory at $presetSource."
} elseif ([string]::IsNullOrWhiteSpace($presetRoot)) {
  # 走到这里说明 $presetRoot 没解析出来。**不静默跳过**：直接退化为手工复制命令，
  # 并明确说明"预设根里必须放真实目录（junction 对 DSH 的预设发现无效）"。
  Write-Warning 'Could not resolve <DSH_HOME>/.agent-presets automatically; do it manually:'
  Write-Warning "  `$root = Join-Path `$env:APPDATA 'dsh-desktop\harness\.agent-presets'"
  Write-Warning "  New-Item -ItemType Directory -Path `$root -Force"
  Write-Warning "  Copy-Item -Recurse -Force `"$presetSource\study`" `"`$root\study`""
  Write-Warning "  Copy-Item -Recurse -Force `"$presetSource\socratic`" `"`$root\socratic`""
  Write-Warning '注意：必须复制**真实目录**，不要用 junction —— DSH 的 scanRoot() 用 isDirectory() 判断，'
  Write-Warning 'Windows 上 junction 被 Node 视为 symbolic link（isDirectory=false），会被直接跳过。'
  Write-Warning "Copy each preset manually, e.g.:`n  Copy-Item -Recurse -Force ""$presetSource\<id>"" ""$harness\.agent-presets\<id>"""
} else {
  if (-not (Test-Path $presetRoot)) {
    New-Item -ItemType Directory -Path $presetRoot -Force | Out-Null
    Write-Host "Created preset root: $presetRoot"
  }
  $linked = 0
  foreach ($dir in Get-ChildItem $presetSource -Directory) {
    if ($dir.Name -notmatch '^[a-z0-9][a-z0-9-]*$') {
      Write-Warning "Skipping '$($dir.Name)': not a usable preset id (must match ^[a-z0-9][a-z0-9-]*$)."
      continue
    }
    if (-not (Test-Path (Join-Path $dir.FullName 'agent.cordis.yml'))) {
      Write-Warning "Skipping '$($dir.Name)': no agent.cordis.yml (not a preset directory)."
      continue
    }
    $presetTarget = Join-Path $presetRoot $dir.Name
    if (Test-Path $presetTarget) {
      $presetItem = Get-Item $presetTarget -Force
      if ($presetItem.LinkType) {
        # 旧版这里是 junction —— 对预设发现无效，换成真实目录
        cmd /c rmdir "$presetTarget"
        Write-Host "Replaced legacy junction with a real directory: $dir.Name"
      } else {
        Remove-Item $presetTarget -Recurse -Force
      }
    }
    Copy-Item -Path $dir.FullName -Destination $presetTarget -Recurse -Force
    Write-Host ("Copied preset: {0}" -f $dir.Name)
    $linked += 1
  }
  Write-Host ("Preset copies handled: {0}. 改了 presets/ 里的文件后重跑本脚本即可刷新" -f $linked)
}

# -- 2. the patch line to put into the profile --------------------------------
# Forward slashes: dsh-app-boot's anchorInsertedPluginNames turns an absolute
# path into a file:// URL.
$entryUrl = $entry.Replace('\', '/')
$snippet = @"
- insert:
    - id: dsh-study-alongwith-ai
      name: '$entryUrl'
      config:
        # The teaching protocol lives in the study preset's persona, so the
        # host-wide mount keeps the TOOLS available in every mode without
        # injecting the protocol into standard / PTC / minimal sessions.
        protocol: false
        command: true
"@

Write-Host ''
Write-Host "Content to put into $patchFile :"
Write-Host '--------------------------------------------------------------'
Write-Host $snippet
Write-Host '--------------------------------------------------------------'

$existing = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
$lines = @($existing -split '\r?\n')
$commentLines = @($lines | Where-Object { $_ -match '^\s*#' })
# The shipped file is a comment header plus a placeholder `[]`. That placeholder
# is a VALUE, not empty space: appending after it produces two top-level arrays
# and an unparseable patch file. So drop the placeholder line, and treat
# "has any other active entry?" as the real emptiness question.
$activeLines = @($lines | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' -and $_.Trim() -ne '[]' })
$hasActiveEntries = ($activeLines.Count -gt 0)

if ($Write) {
  if ($bundleInstalled -and -not $Force) {
    # Writing this would insert a second row with the same id: the plugin mounts
    # twice and opens the storage domain twice, which is a failure this repo has
    # already produced once. Refuse rather than reproduce it.
    Write-Warning @"
Refusing to write the dev patch: this profile already loads the plugin as a
bundle ('dsh-study-alongwith-ai' is in dsh.profile.bundles). Adding the dev
insert too would mount the same id twice.

  - To develop against the repo, remove the bundle first:
        dsh plugin --profile $ProfileName remove dsh-study-alongwith-ai
  - Or pass -Force if you really intend to run both (expect a duplicated mount).
"@
    Write-Host ''
  } elseif ($hasActiveEntries -and -not $Force) {
    Write-Warning "File already has active entries; left untouched to avoid overwriting your config.`nMerge the insert above manually, or pass -Force to replace those entries:`n$patchFile"
    Write-Host ''
    Write-Host 'Existing active entries:'
    $activeLines | ForEach-Object { Write-Host "  $_" }
  } else {
    if ($hasActiveEntries) {
      Write-Warning 'Force: replacing the existing active entries listed below with this plugin insert.'
      $activeLines | ForEach-Object { Write-Host "  $_" }
    }
    # Keep the file's own comments; write WITH our insert and WITHOUT a BOM
    # (a BOM can break YAML parsers).
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $head = if ($commentLines.Count -gt 0) { ($commentLines -join "`n") + "`n" } else { '' }
    $combined = "$head$snippet`n"
    [System.IO.File]::WriteAllText($patchFile, $combined, $utf8NoBom)
    Write-Host "Written: $patchFile"
    Write-Host 'The profile uses patchReload=live, so DSH hot-reloads; restart the app if it does not.'
  }
} else {
  Write-Host ''
  Write-Host '(dry run - pass -Write to write it automatically, and only when the file is empty)'
}

Write-Host ''
Write-Host 'How to confirm after starting DSH:'
Write-Host '  1. type / in the composer - the command list should contain "study"'
Write-Host '  2. send any message - the tool list should contain 8 study_* tools'
Write-Host '  3. the log should show: study plugin mounted (domain study_alongwith_ai, storage: domain)'
Write-Host '     if it says storage: memory, the host exposes no storage.domain and'
Write-Host '     data lives only in this run''s memory'
