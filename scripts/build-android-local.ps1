param(
  [string]$BuildDirectory = 'C:\hb-build\erp',
  [string]$Architectures = '',
  [ValidateSet('preview','stable','production')]
  [string]$Variant = 'stable'
)
$ErrorActionPreference = 'Stop'
if (-not $Architectures) {
  # Phone releases include one ABI. Opt into preview for emulator/universal APKs.
  $Architectures = if ($Variant -eq 'preview') { 'arm64-v8a,armeabi-v7a,x86_64,x86' } else { 'arm64-v8a' }
}
function Invoke-AndroidNative {
  param([string]$File, [string[]]$Arguments)
  $previousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5 treats native stderr warnings as errors when redirected.
    $ErrorActionPreference = 'Continue'
    & $File @Arguments 2>&1 | ForEach-Object { $_.ToString() }
    $nativeExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($nativeExitCode -ne 0) { throw "Native build command failed (exit $nativeExitCode): $File" }
}
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mobileSource = Join-Path $sourceRoot 'apps/mobile'
$portableNode = Join-Path $sourceRoot '.local/runtime/node-v26.13.1-win-x64/node.exe'
$nodeExe = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node -ErrorAction Stop).Source }
$sdkRoot = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')
$javaRoot = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
if (-not $sdkRoot -or -not (Test-Path (Join-Path $sdkRoot 'platform-tools/adb.exe'))) { throw 'Android SDK is missing. Run the Android toolchain setup first.' }
if (-not $javaRoot -or -not (Test-Path (Join-Path $javaRoot 'bin/java.exe'))) { throw 'JAVA_HOME is not configured.' }
if ($Architectures -notmatch '^(arm64-v8a|armeabi-v7a|x86_64|x86)(,(arm64-v8a|armeabi-v7a|x86_64|x86))*$') { throw 'Invalid Android architecture list.' }
$signingFile = 'C:\Android\signing\hawlader-battery\credentials.dpapi'
if (-not (Test-Path -LiteralPath $signingFile)) { throw 'Local Android release signing credentials are missing.' }
$protectedSigning = (Get-Content -LiteralPath $signingFile -Raw).Trim() | ConvertTo-SecureString
$signing = (New-Object System.Management.Automation.PSCredential('android-signing', $protectedSigning)).GetNetworkCredential().Password | ConvertFrom-Json
$savedLocation = Get-Location
$envNames = @('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','Path','APP_VARIANT','EXPO_PUBLIC_SERVER_URL','EXPO_NO_TELEMETRY','EXPO_OFFLINE','HAWLADER_LOCAL_KEYSTORE_FILE','HAWLADER_LOCAL_STORE_PASSWORD','HAWLADER_LOCAL_KEY_ALIAS','HAWLADER_LOCAL_KEY_PASSWORD')
$previousEnv = @{}
foreach ($name in $envNames) { $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  $env:JAVA_HOME = $javaRoot
  $env:ANDROID_HOME = $sdkRoot
  $env:ANDROID_SDK_ROOT = $sdkRoot
  $env:Path = (Split-Path $nodeExe) + ';' + (Join-Path $javaRoot 'bin') + ';' + (Join-Path $sdkRoot 'platform-tools') + ';' + $env:Path
  $env:APP_VARIANT = $Variant
  $env:EXPO_NO_TELEMETRY = '1'
  $env:EXPO_OFFLINE = '1'
  $env:HAWLADER_LOCAL_KEYSTORE_FILE = $signing.keystorePath
  $env:HAWLADER_LOCAL_STORE_PASSWORD = $signing.keystorePassword
  $env:HAWLADER_LOCAL_KEY_ALIAS = $signing.keyAlias
  $env:HAWLADER_LOCAL_KEY_PASSWORD = if ($signing.keyPassword) { $signing.keyPassword } else { $signing.keystorePassword }
  if (-not $env:EXPO_PUBLIC_SERVER_URL) {
    $localEnvironment = Join-Path $mobileSource '.env.local'
    if (Test-Path -LiteralPath $localEnvironment) {
      $serverSetting = Get-Content -LiteralPath $localEnvironment | Where-Object { $_ -match '^EXPO_PUBLIC_SERVER_URL=' } | Select-Object -First 1
      if ($serverSetting) { $env:EXPO_PUBLIC_SERVER_URL = ($serverSetting -replace '^EXPO_PUBLIC_SERVER_URL=', '').Trim().Trim('"').Trim("'") }
    }
  }
  if (-not $env:EXPO_PUBLIC_SERVER_URL) { throw 'Set EXPO_PUBLIC_SERVER_URL to the ERP website address before building.' }
  Set-Location -LiteralPath $sourceRoot
  Invoke-AndroidNative -File $nodeExe -Arguments @((Join-Path $PSScriptRoot 'prepare-android-workspace.mjs'), $BuildDirectory)
  Set-Location -LiteralPath $BuildDirectory
  $dependencyStamp = Join-Path $BuildDirectory '.hawlader-dependencies.sha256'
  $lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
  if (-not (Test-Path 'node_modules/expo/bin/cli') -or -not (Test-Path $dependencyStamp) -or ((Get-Content $dependencyStamp -Raw).Trim() -ne $lockHash)) {
    Invoke-AndroidNative -File (Join-Path (Split-Path $nodeExe) 'npm.cmd') -Arguments @('ci','--no-audit','--no-fund')
    Set-Content -LiteralPath $dependencyStamp -Value $lockHash -Encoding ASCII
  }
  Set-Location -LiteralPath (Join-Path $BuildDirectory 'apps/mobile')
  $nativeVersionStamp = Join-Path $BuildDirectory '.hawlader-native-sdk.txt'
  $installedExpoVersion = (Get-Content -LiteralPath (Join-Path $BuildDirectory 'node_modules/expo/package.json') -Raw | ConvertFrom-Json).version
  $installedReactNativeVersion = (Get-Content -LiteralPath (Join-Path $BuildDirectory 'node_modules/react-native/package.json') -Raw | ConvertFrom-Json).version
  $nativeVersions = "$installedExpoVersion|$installedReactNativeVersion"
  $sdkChanged = (Test-Path -LiteralPath $nativeVersionStamp) -and ((Get-Content -LiteralPath $nativeVersionStamp -Raw).Trim() -ne $nativeVersions)
  $prebuildArguments = @('../../node_modules/expo/bin/cli','prebuild','--platform','android','--no-install')
  # SDK 58 cleans by default. Keep daily native outputs unless the SDK/RN versions change.
  if ((Test-Path -LiteralPath 'android/gradlew.bat') -and -not $sdkChanged) { $prebuildArguments += '--no-clean' }
  Invoke-AndroidNative -File $nodeExe -Arguments $prebuildArguments
  Set-Content -LiteralPath $nativeVersionStamp -Value $nativeVersions -Encoding ASCII
  # Expo DOM writes hashed assets without removing older hashes. Only clear
  # this owned build workspace's generated release assets, never source/data.
  $generatedRoot = [IO.Path]::GetFullPath((Join-Path $BuildDirectory 'apps/mobile/android/app/build/generated'))
  foreach ($relativeOutput in @('assets/react/release','res/react/release')) {
    $generatedOutput = [IO.Path]::GetFullPath((Join-Path $generatedRoot $relativeOutput))
    if (-not $generatedOutput.StartsWith($generatedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Generated asset cleanup escaped its build directory.' }
    if (Test-Path -LiteralPath $generatedOutput) {
      $resolvedOutput = (Resolve-Path -LiteralPath $generatedOutput).ProviderPath
      if (-not $resolvedOutput.StartsWith($generatedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved generated asset path is outside the build directory.' }
      Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
    }
  }
  Set-Location -LiteralPath 'android'
  Invoke-AndroidNative -File '.\gradlew.bat' -Arguments @(':app:assembleRelease',"-PreactNativeArchitectures=$Architectures",'-Pandroid.cmakeVersion=3.30.5','-Dorg.gradle.jvmargs=-Xmx4096m','--max-workers=4','--build-cache','--console=plain')
  $apkSource = Join-Path $BuildDirectory 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk'
  if (-not (Test-Path -LiteralPath $apkSource)) { throw 'Gradle did not produce the expected APK.' }
  $outputDirectory = Join-Path $sourceRoot '.local/apks'
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
  $versionName = (Get-Content -LiteralPath (Join-Path $mobileSource 'package.json') -Raw | ConvertFrom-Json).version
  $outputName = if ($Variant -eq 'preview') { 'Hawlader-Battery-local.apk' } else { "Howlader-Battery-$versionName-$Variant.apk" }
  $output = Join-Path $outputDirectory $outputName
  Copy-Item -LiteralPath $apkSource -Destination $output -Force
  Write-Output "Local APK ready: $output"
  Write-Output "Android architectures: $Architectures"
  Write-Output ('SHA256: ' + (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash)
} finally {
  Set-Location -LiteralPath $savedLocation
  foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process') }
}
