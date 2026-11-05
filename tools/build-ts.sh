#!/usr/bin/env bash
# Compile MetadataScrubber's TypeScript (ts/ and the Android bridge script) into the JavaScript the
# page and the app load, and type-check the JavaScript that is still hand-written.
#
# Copied on 1 November 2026 from GDPRLetterBuilder's tools/build-ts.sh (itself from EclipseTracker's
# and the Website's). Changed for MetadataScrubber: the files move to TypeScript one per commit
# (TS-STEP-1), so for a while the repository holds both compiled and hand-written JavaScript. Every
# program runs only when it has sources, and zero compiled files is a valid state. While
# jsconfig.json exists, the hand-written JavaScript it lists is type-checked as before
# (types/stamped-imports.mjs, then tsc on jsconfig.json), and the list of files still to convert,
# tools/js-to-convert.txt, says which JavaScript may exist without a TypeScript source. There is no
# golden-file step. gate.js is not compiled here: build-gates.py at the root of the GitHub folder
# writes it, and it is allowed by name.
#
#   tools/build-ts.sh           install the pinned compiler, compile every ts/**/*.ts into the .js
#                               of the same path at the repository root (ts/app.ts -> app.js,
#                               ts/src/x.ts -> src/x.js; ts/*.d.ts are types only and emit nothing),
#                               compile the Android app's bridge script,
#                               android/web-overlay/android-bridge.ts, into android-bridge.js beside
#                               it (a classic script, never published) once that source exists, then
#                               run bump_assets.py so every import and every page carries the
#                               current ?v= stamp, and last type-check the hand-written JavaScript
#   tools/build-ts.sh --force   the same, but overwrite a compiled .js even when it holds a hand
#                               edit (also how a conversion step replaces the old hand-written .js)
#   tools/build-ts.sh --check   change nothing: fail when a compiled .js is missing, is not tracked
#                               by git (in a git checkout), is not marked linguist-generated, or is
#                               not (stamps aside) byte for byte what its source compiles to; when
#                               the repository holds JavaScript that is neither compiled output,
#                               nor gate.js, nor listed in tools/js-to-convert.txt; when that list
#                               and jsconfig.json disagree with the tree; when a page or an import
#                               carries a stale ?v=; or when the hand-written JavaScript does not
#                               type-check
#
# Stamps. bump_assets.py stamps every relative import with the imported file's hash (?v=...), so a
# compiled .js at the root differs from what tsc writes in exactly those stamps. Every comparison
# below strips them first ("normalised"), and bump_assets.py --check then proves the stamps
# themselves are current. The TypeScript imports carry no stamp.
#
# Every mode first type-checks, and writes nothing when one fails:
#   * ts/src/ with tsconfig.core.json, whose only library is ES2022 (plus ts/core-env.d.ts and
#     ts/node-shim.d.ts): no DOM. The engine runs in the browser and under Node alike.
#   * the tests (tests/*.ts, run by Node 24 directly) with tests/tsconfig.json, strict, once the
#     first test is TypeScript.
#   * ts/ with tsconfig.json, strict, which also emits.
#   * the bridge script with android/web-overlay/tsconfig.json, once android-bridge.ts exists. That
#     program is emitted into a scratch folder and only android-bridge.js is taken from it. It has
#     no ?v= stamps.
# The hand-written JavaScript is checked last, after the compiled files and the stamps are written,
# because types/stamped-imports.d.ts follows the stamps. A failure there exits 1 with the compiled
# files already written; they are exact compilations of their sources, so nothing wrong is left.
#
# The compiled .js files are committed on purpose: GitHub Pages publishes the repository's files as
# they are, with no build step of its own, and the Android build bundles them as they are and never
# runs tsc. Edit the TypeScript, never the .js. .gitattributes marks them linguist-generated.
#
# Hand edits. A build never overwrites a compiled .js silently. It writes only when the .js now on
# disk, normalised, is one some TypeScript source produced: what the committed sources (HEAD)
# compile to, what the current sources compile to, or what this script wrote last time. Anything
# else is an edit made in the .js itself (or, in a conversion step, the old hand-written file): the
# build stops and writes nothing. Port the edit into the TypeScript and build again, or rerun with
# --force to drop it. The record of the last build lives in the git directory (build-ts.last) in a
# git checkout, so it is never committed or published; outside git it is .build-ts.last at the
# root, a dot file that neither Pages nor the APK takes, listed in .gitignore.
#
# The compiler is the exact version in package-lock.json, installed with `npm ci` (a frozen install)
# and with install scripts off. Needs Node 24 and npm, python3, and git only for the HEAD record,
# the tracked-file and the attribute checks (all skipped outside a git checkout).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "$#:${1:-}" in
  0:)        MODE=build ;;
  1:--force) MODE=force ;;
  1:--check) MODE=check ;;
  *)         echo "usage: $0 [--check | --force]" >&2; exit 2 ;;
esac

die() { echo "build-ts: $*" >&2; exit 1; }
command -v node >/dev/null || die "node not found"
command -v npm >/dev/null || die "npm not found"
command -v python3 >/dev/null || die "python3 not found"
GIT=0
if command -v git >/dev/null && [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$ROOT" ]; then GIT=1; fi

npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error >/dev/null \
  || die "npm ci failed (package.json and package-lock.json must agree; nothing was compiled)"
TSC=(node "$ROOT/node_modules/typescript/bin/tsc")
echo "build-ts: TypeScript $("${TSC[@]}" --version | sed 's/^Version //')"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A relative import with its ?v= stamp removed: from './src/x.js?v=0123abcd' to from './src/x.js'.
normalise() { sed -E "s#(['\"]\\.{1,2}/[^'\"?]+\\.js)\\?v=[0-9a-f]{8}(['\"])#\\1\\2#g" "$1"; }
nsha() { normalise "$1" | sha256sum | cut -d' ' -f1; }

# The move to TypeScript is under way while jsconfig.json exists (TS-STEP-1).
TRANSITION=0; [ -f jsconfig.json ] && TRANSITION=1
LIST=tools/js-to-convert.txt
BRIDGE=android/web-overlay/android-bridge.js
HAS_BRIDGE_TS=0; [ -f "${BRIDGE%.js}.ts" ] && HAS_BRIDGE_TS=1

"${TSC[@]}" -p "$ROOT/tsconfig.core.json" \
  || die "ts/src/ uses something only a browser has, or does not type-check (see above): the engine stays free of the DOM; nothing was written"
if compgen -G "tests/*.ts" >/dev/null; then
  "${TSC[@]}" -p "$ROOT/tests/tsconfig.json" || die "the tests (tests/*.ts) do not type-check; nothing was written"
fi
"${TSC[@]}" -p "$ROOT/tsconfig.json" --outDir "$tmp/out" || die "ts/ does not compile; nothing was written"
mkdir -p "$tmp/out"

mapfile -t OUTPUTS < <(cd "$tmp/out" && find . -type f -printf '%P\n' | LC_ALL=C sort)
mapfile -t EXPECTED < <(cd ts && find . -type f -name '*.ts' ! -name '*.d.ts' -printf '%P\n' | sed 's/\.ts$/.js/' | LC_ALL=C sort)
[ "${OUTPUTS[*]}" = "${EXPECTED[*]}" ] \
  || die "tsc emitted [${OUTPUTS[*]}] but ts/ holds sources for [${EXPECTED[*]}]; look at tsconfig.json"
[ "${#OUTPUTS[@]}" -gt 0 ] || echo "build-ts: ts/ holds no source yet that emits JavaScript (types only)"

# The Android bridge script: its own program, of which only android-bridge.js is kept.
if [ "$HAS_BRIDGE_TS" = 1 ]; then
  "${TSC[@]}" -p "$ROOT/android/web-overlay/tsconfig.json" --noEmit false --outDir "$tmp/bridge" \
    || die "${BRIDGE%.js}.ts does not compile; nothing was written"
  [ -f "$tmp/bridge/$BRIDGE" ] || die "tsc did not emit $BRIDGE; look at android/web-overlay/tsconfig.json"
  mkdir -p "$tmp/out/$(dirname "$BRIDGE")"
  cp "$tmp/bridge/$BRIDGE" "$tmp/out/$BRIDGE"
  OUTPUTS+=("$BRIDGE")
fi

# Where each compiled file comes from, for the messages.
source_of() { if [ "$1" = "$BRIDGE" ]; then echo "${BRIDGE%.js}.ts"; else echo "ts/${1%.js}.ts"; fi; }

# "./$1": a path that git reads as a path, whatever it starts with.
tracked() { [ "$GIT" = 1 ] && git ls-files --error-unmatch "./$1" >/dev/null 2>&1; }

# The hand-written JavaScript still to convert: the first column of tools/js-to-convert.txt.
LISTED=()
if [ -f "$LIST" ]; then
  mapfile -t LISTED < <(sed -e 's/#.*//' "$LIST" | awk 'NF { print $1 }')
fi
listed() { case " ${LISTED[*]} " in *" $1 "*) return 0 ;; esac; return 1; }

# The hand-written JavaScript is type-checked as before the move, while jsconfig.json exists.
check_js() {
  [ "$TRANSITION" = 1 ] || return 0
  if [ "$1" = check ]; then
    node "$ROOT/types/stamped-imports.mjs" --check || return 1
  else
    node "$ROOT/types/stamped-imports.mjs" || return 1
  fi
  "${TSC[@]}" -p "$ROOT/jsconfig.json" || { echo "build-ts: the hand-written JavaScript (jsconfig.json) does not type-check" >&2; return 1; }
  echo "build-ts: the hand-written JavaScript type-checks (jsconfig.json)"
}

if [ "$MODE" = check ]; then
  bad=0
  [ "$GIT" = 1 ] || echo "build-ts: not a git checkout; skipping the tracked-file and attribute checks"
  for f in "${OUTPUTS[@]}"; do
    if [ ! -f "$f" ]; then
      echo "build-ts: $f is missing: run tools/build-ts.sh" >&2; bad=1
    elif [ "$(nsha "$f")" != "$(nsha "$tmp/out/$f")" ]; then
      echo "build-ts: $f is NOT what $(source_of "$f") compiles to: edit $(source_of "$f"), then run tools/build-ts.sh" >&2; bad=1
    elif [ "$GIT" = 1 ] && ! tracked "$f"; then
      echo "build-ts: $f is what $(source_of "$f") compiles to but is not tracked by git: git add it" >&2; bad=1
    elif [ "$GIT" = 1 ] && [ "$(git check-attr linguist-generated -- "$f" | sed 's/.*: //')" != true ]; then
      echo "build-ts: $f is compiled output but .gitattributes does not mark it linguist-generated" >&2; bad=1
    else
      echo "build-ts: $f matches $(source_of "$f")"
    fi
  done

  # JavaScript with no source. Every JavaScript file git tracks, and every one on disk where the
  # page and the app load from (the root, src/, android/web-overlay/), must be compiled output,
  # gate.js (written by build-gates.py) or a hand-written file still listed in tools/js-to-convert.txt.
  mapfile -t PRESENT < <({
    if [ "$GIT" = 1 ]; then git ls-files -- '*.js' '*.mjs' '*.cjs'; fi
    find . -maxdepth 1 -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -printf '%P\n'
    for d in src android/web-overlay; do [ -d "$d" ] && find "$d" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \); done
    if [ "$GIT" = 0 ]; then
      find . \( -name node_modules -o -name .git -o -name build -o -name .gradle \) -prune -o -type f \
        \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -printf '%P\n'
    fi; } | LC_ALL=C sort -u)
  for f in "${PRESENT[@]}"; do
    case " ${OUTPUTS[*]} " in *" $f "*) continue ;; esac
    [ "$f" = gate.js ] && continue
    listed "$f" && continue
    echo "build-ts: $f is JavaScript that no TypeScript source compiles to and that $LIST does not list: delete it, or restore its source" >&2; bad=1
  done
  [ -f gate.js ] || { echo "build-ts: gate.js is missing (build-gates.py writes it)" >&2; bad=1; }
  if [ "$GIT" = 1 ] && [ -f gate.js ] && [ "$(git check-attr linguist-generated -- gate.js | sed 's/.*: //')" != true ]; then
    echo "build-ts: .gitattributes does not mark gate.js linguist-generated" >&2; bad=1
  fi

  # The list of files still to convert, against the tree and jsconfig.json.
  if [ "$TRANSITION" = 1 ] && [ ! -f "$LIST" ]; then
    echo "build-ts: jsconfig.json exists but $LIST does not: the move is either under way (both) or done (neither)" >&2; bad=1
  fi
  if [ -f "$LIST" ]; then
    [ "$TRANSITION" = 1 ] || { echo "build-ts: $LIST exists but jsconfig.json does not" >&2; bad=1; }
    CHECKED=()
    if [ "$TRANSITION" = 1 ]; then
      mapfile -t CHECKED < <("${TSC[@]}" -p "$ROOT/jsconfig.json" --showConfig \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const f of JSON.parse(s).files||[])console.log(f.replace(/^\.\//,""))})')
    fi
    while read -r path target group; do
      if [ ! -f "$path" ]; then
        echo "build-ts: $LIST lists $path, which does not exist: delete its line" >&2; bad=1; continue
      fi
      if [ "$GIT" = 1 ] && ! tracked "$path"; then
        echo "build-ts: $LIST lists $path, which git does not track" >&2; bad=1
      fi
      if [ "$target" != retire ] && [ -f "$target" ]; then
        echo "build-ts: $path is listed as hand-written, but $target exists: finish the conversion and delete its line in $LIST" >&2; bad=1
      fi
      case "$path" in
        app.js|src/*)
          case " ${CHECKED[*]} " in
            *" $path "*) ;;
            *) echo "build-ts: $path is hand-written ($group) but jsconfig.json does not type-check it" >&2; bad=1 ;;
          esac ;;
      esac
    done < <(sed -e 's/#.*//' "$LIST" | awk 'NF')
    for f in "${CHECKED[@]}"; do
      case "$f" in
        *.js|*.mjs) listed "$f" || { echo "build-ts: jsconfig.json type-checks $f, which is not hand-written any more: take it out of the include list" >&2; bad=1; } ;;
      esac
    done
    echo "build-ts: $LIST lists ${#LISTED[@]} hand-written file(s) still to convert"
  fi

  python3 -I "$ROOT/bump_assets.py" --check || bad=1
  check_js check || bad=1
  [ "$bad" = 0 ] || exit 1
  echo "build-ts: check passed"
  exit 0
fi

if [ "$GIT" = 1 ]; then STATE="$(git rev-parse --absolute-git-dir)/build-ts.last"; else STATE="$ROOT/.build-ts.last"; fi

if [ "$MODE" = build ]; then
  if [ "$GIT" = 1 ] && git cat-file -e HEAD:tsconfig.json 2>/dev/null && git cat-file -e HEAD:ts 2>/dev/null; then
    mkdir -p "$tmp/head"
    git archive HEAD tsconfig.json ts | tar -x -C "$tmp/head"
    "${TSC[@]}" -p "$tmp/head/tsconfig.json" --outDir "$tmp/head-out" >/dev/null 2>&1 || true
    # The bridge as the committed android-bridge.ts compiles.
    if git cat-file -e "HEAD:${BRIDGE%.js}.ts" 2>/dev/null && git cat-file -e HEAD:android/web-overlay/tsconfig.json 2>/dev/null; then
      git archive HEAD "${BRIDGE%.js}.ts" android/web-overlay/tsconfig.json | tar -x -C "$tmp/head"
      if "${TSC[@]}" -p "$tmp/head/android/web-overlay/tsconfig.json" --noEmit false --outDir "$tmp/head-bridge" >/dev/null 2>&1; then
        mkdir -p "$tmp/head-out/$(dirname "$BRIDGE")"
        cp "$tmp/head-bridge/$BRIDGE" "$tmp/head-out/$BRIDGE"
      fi
    fi
  fi
  hand=()
  for f in "${OUTPUTS[@]}"; do
    [ -f "$f" ] || continue
    cur="$(nsha "$f")"
    [ "$cur" = "$(nsha "$tmp/out/$f")" ] && continue
    [ -f "$tmp/head-out/$f" ] && [ "$cur" = "$(nsha "$tmp/head-out/$f")" ] && continue
    [ -f "$STATE" ] && grep -qxF "$cur  $f" "$STATE" && continue
    hand+=("$f")
  done
  if [ "${#hand[@]}" -gt 0 ]; then
    for f in "${hand[@]}"; do
      echo "build-ts: $f holds changes that no TypeScript source produced (edited by hand, or the old hand-written file?)" >&2
    done
    die "nothing was written. Port the change into its TypeScript source, then build again; or run tools/build-ts.sh --force to overwrite it."
  fi
fi

wrote=0
for f in "${OUTPUTS[@]}"; do
  if [ -f "$f" ] && [ "$(nsha "$f")" = "$(nsha "$tmp/out/$f")" ]; then continue; fi
  mkdir -p "$(dirname "$f")"
  cp "$tmp/out/$f" "$f"
  echo "build-ts: wrote $f"
  wrote=1
  if [ "$GIT" = 1 ] && ! tracked "$f"; then
    echo "build-ts: $f is new: git add it" >&2
  fi
done
[ "$wrote" = 1 ] || echo "build-ts: compiled output unchanged"
for f in "${OUTPUTS[@]}"; do printf '%s  %s\n' "$(nsha "$f")" "$f"; done > "$STATE"

# Always: bump_assets.py changes nothing when every stamp is current, and repairs a stale one even
# when the compiled output did not change.
python3 -I "$ROOT/bump_assets.py"

check_js build || exit 1
