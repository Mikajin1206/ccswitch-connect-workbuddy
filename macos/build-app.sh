#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
app_name="WorkBuddy Model Bridge"
app_path="$repo_root/macos/build/$app_name.app"
zip_path="$repo_root/macos/build/$app_name.zip"
node_path="$(command -v node)"
icon_source="$repo_root/macos/WorkBuddyModelBridge/Resources/AppIcon.png"
asset_catalog_path="$repo_root/macos/build/Assets.xcassets"
app_icon_set_path="$asset_catalog_path/AppIcon.appiconset"
asset_output_path="$repo_root/macos/build/app-assets"
swift_build_path="$repo_root/macos/build/swiftpm"
swift_cache_path="$repo_root/macos/build/cache"
swift_module_cache_path="$repo_root/macos/build/clang-module-cache"

cleanup_build_temporaries() {
  rm -rf "$swift_build_path" "$swift_cache_path" "$swift_module_cache_path" \
    "$asset_catalog_path" "$asset_output_path" "$repo_root/macos/build/app-icon-info.plist" \
    "$repo_root/macos/build/(A Document Being Saved By swift-build)"
}
trap cleanup_build_temporaries EXIT

cd "$repo_root"
npm run build
mkdir -p "$swift_module_cache_path"
export SWIFTPM_MODULECACHE_OVERRIDE="$swift_module_cache_path"
export CLANG_MODULE_CACHE_PATH="$swift_module_cache_path"
swift build --disable-sandbox --disable-index-store -debug-info-format none \
  --package-path "$repo_root/macos/WorkBuddyModelBridge" \
  --scratch-path "$swift_build_path" \
  --cache-path "$swift_cache_path" \
  --configuration release

rm -rf "$app_path" "$asset_catalog_path" "$asset_output_path"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/Gateway"
cp "$swift_build_path/out/Products/Release/WorkBuddyModelBridge" "$app_path/Contents/MacOS/WorkBuddyModelBridge"
cp "$node_path" "$app_path/Contents/MacOS/node"
cp "$repo_root/macos/WorkBuddyModelBridge/Info.plist" "$app_path/Contents/Info.plist"
cp "$repo_root"/lib/*.js "$app_path/Contents/Resources/Gateway/"

make_icon() {
  local pixels="$1"
  local filename="$2"
  sips -z "$pixels" "$pixels" "$icon_source" --out "$app_icon_set_path/$filename" >/dev/null
}

retina_mark="$(printf '\100')"
mkdir -p "$app_icon_set_path" "$asset_output_path"
make_icon 16 icon_16x16.png
make_icon 32 "icon_16x16${retina_mark}2x.png"
make_icon 32 icon_32x32.png
make_icon 64 "icon_32x32${retina_mark}2x.png"
make_icon 128 icon_128x128.png
make_icon 256 "icon_128x128${retina_mark}2x.png"
make_icon 256 icon_256x256.png
make_icon 512 "icon_256x256${retina_mark}2x.png"
make_icon 512 icon_512x512.png
make_icon 1024 "icon_512x512${retina_mark}2x.png"
cat > "$app_icon_set_path/Contents.json" <<JSON
{"images":[{"filename":"icon_16x16.png","idiom":"mac","scale":"1x","size":"16x16"},{"filename":"icon_16x16${retina_mark}2x.png","idiom":"mac","scale":"2x","size":"16x16"},{"filename":"icon_32x32.png","idiom":"mac","scale":"1x","size":"32x32"},{"filename":"icon_32x32${retina_mark}2x.png","idiom":"mac","scale":"2x","size":"32x32"},{"filename":"icon_128x128.png","idiom":"mac","scale":"1x","size":"128x128"},{"filename":"icon_128x128${retina_mark}2x.png","idiom":"mac","scale":"2x","size":"128x128"},{"filename":"icon_256x256.png","idiom":"mac","scale":"1x","size":"256x256"},{"filename":"icon_256x256${retina_mark}2x.png","idiom":"mac","scale":"2x","size":"256x256"},{"filename":"icon_512x512.png","idiom":"mac","scale":"1x","size":"512x512"},{"filename":"icon_512x512${retina_mark}2x.png","idiom":"mac","scale":"2x","size":"512x512"}],"info":{"author":"xcode","version":1}}
JSON
xcrun actool --compile "$asset_output_path" --platform macosx --minimum-deployment-target 14.0 \
  --app-icon AppIcon --output-partial-info-plist "$repo_root/macos/build/app-icon-info.plist" "$asset_catalog_path" >/dev/null
cp "$asset_output_path/AppIcon.icns" "$app_path/Contents/Resources/AppIcon.icns"
cp "$asset_output_path/Assets.car" "$app_path/Contents/Resources/Assets.car"

cat > "$app_path/Contents/Resources/Gateway/package.json" <<'JSON'
{"type":"module"}
JSON

codesign --force --deep --sign - "$app_path"

rm -f "$zip_path"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"

printf 'Built app: %s\n' "$app_path"
printf 'Built install package: %s\n' "$zip_path"
