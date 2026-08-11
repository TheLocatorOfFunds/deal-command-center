# Xcode 26.5 local-sim compatibility patches

These patches only exist for **local iOS simulator builds on Xcode 26.5
(Tahoe)**. EAS Cloud builds run Xcode 16 and do not need them - leave
them alone there.

## Hermes / react-native (this directory)

`react-native+0.81.5.patch` adds explicit `<atomic>` and `<thread>`
includes to `HermesExecutorFactory.cpp`. Xcode 26.5's libc++ stopped
transitively including those headers, so `std::thread` and
`std::atomic` no longer resolve from the existing transitive chain.

Applied automatically by the `postinstall: patch-package` script in
`mobile/package.json` every time `npm install` runs. Nothing to do by
hand - if a fresh `npm install` does not log
`Applied patch react-native+0.81.5.patch cleanly`, something is wrong
with patch-package's wiring.

## fmt / CocoaPods (not in patch-package - lives in the Podfile)

`mobile/ios/` is fully gitignored (Expo prebuild flow regenerates it),
so the fmt fix cannot live as a tracked source file. Instead, the
Podfile's `post_install` block contains an idempotent patcher that
rewrites `Pods/fmt/include/fmt/base.h` after every `pod install`.

If you regenerate `ios/` (via `expo prebuild --clean` or by deleting
`mobile/ios/` to start over) you must re-add the hook to the new
`mobile/ios/Podfile` before running `pod install`. Paste this inside
the existing `post_install do |installer|` block, after the
`react_native_post_install(...)` call:

```ruby
# Xcode 26.5 compatibility patches (local-sim QA only; not used by EAS Cloud).
# fmt 11.x's base.h unconditionally sets FMT_USE_CONSTEVAL=1 when Apple
# Clang supports __cpp_consteval (which Xcode 26.5 does). The feature-
# detection block has no `#ifndef FMT_USE_CONSTEVAL` guard, so a -D flag
# is useless. We must patch the source directly: rewrite the
# "#define FMT_USE_CONSTEVAL 1" line to set it to 0. Xcode 26.5's stricter
# consteval rejects fmt's call sites. The patch is idempotent.
fmt_base = File.join(__dir__, 'Pods/fmt/include/fmt/base.h')
if File.exist?(fmt_base) && !File.read(fmt_base).include?('XCODE26_PATCHED')
  patched = File.read(fmt_base).gsub(
    /^(#  define FMT_USE_CONSTEVAL 1)$/,
    '#  define FMT_USE_CONSTEVAL 0  // XCODE26_PATCHED'
  )
  File.write(fmt_base, patched)
  puts "[Podfile] Patched fmt base.h to disable consteval for Xcode 26.5"
end

# Apple Silicon simulator only needs arm64; exclude x86_64 for pod targets.
installer.pods_project.targets.each do |target|
  target.build_configurations.each do |config|
    config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'x86_64 i386'
  end
end
```

A clean `pod install` should print
`[Podfile] Patched fmt base.h to disable consteval for Xcode 26.5`
exactly once. The marker comment (`// XCODE26_PATCHED`) makes the
patcher a no-op on subsequent runs.

## Removing these patches

Both go away when react-native ships a version with the missing
includes and fmt ships a version whose call sites compile under Xcode
26.5's stricter consteval. Until then, treat both as required for
local builds and irrelevant to EAS Cloud.
