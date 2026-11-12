#!/bin/bash
# Upload only what changed to GitHub Pages, then wait until the site serves it.
#
#   tools/deploy.sh        shows the changed files and asks before uploading
#   tools/deploy.sh -y     uploads without asking
#
# The local folder is the source of truth: files added or changed here go up, files that exist only
# on GitHub are left alone. Sync files and booking photos never leave this Mac.
set -euo pipefail
cd "$(dirname "$0")/.."

SITE="https://woo72da.github.io/tokyo-trip"
APP_FILES="app.js styles.css index.html sw.js"
red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
die() { red "중단: $1"; exit 1; }

[ -d .git ] || die "이 폴더가 GitHub 저장소와 연결되어 있지 않아요."

# 1. sw.js and app.js must carry the same version.
v_sw=$(grep -o "trip-v[0-9]*" sw.js | head -1 | tr -dc 0-9)
v_app=$(grep -o "APP_VERSION = [0-9]*" app.js | head -1 | tr -dc 0-9)
[ "$v_sw" = "$v_app" ] || die "sw.js(v$v_sw)와 app.js(v$v_app)의 버전이 달라요."

# 2. Compare with what GitHub has now (also picks up anything uploaded through the website).
git fetch -q origin main || die "GitHub에 연결하지 못했어요. 인터넷을 확인해 주세요."
git reset -q origin/main
git add --ignore-removal .
changed=$(git diff --cached --name-only)
if [ -z "$changed" ]; then green "올릴 변경이 없어요. 사이트는 이미 최신이에요 (v$v_app)."; exit 0; fi

# 3. Screen changes have to come with a new version, or phones keep the old cached files.
remote_v=$(git show origin/main:sw.js | grep -o "trip-v[0-9]*" | head -1 | tr -dc 0-9)
for f in $APP_FILES; do
  if echo "$changed" | grep -qx "$f" && [ "$v_sw" = "$remote_v" ]; then
    git reset -q; die "$f가 바뀌었는데 버전이 그대로예요 (v$v_sw). sw.js와 app.js의 버전을 올려 주세요."
  fi
done

# 4. Nothing private goes up: sync files, eSIM codes, stray JSON.
while IFS= read -r f; do
  case "$f" in
    data/trip.json|manifest.webmanifest|audio/index.json|package.json|vercel.json) ;;
    *.json) git reset -q; die "$f는 올리지 않는 파일이에요 (동기화 파일일 수 있어요)." ;;
  esac
done <<< "$changed"
if git diff --cached -U0 | grep -E '^\+' | grep -qiE 'LPA:1\$|esim.*https?://'; then
  git reset -q; die "eSIM 설치 링크로 보이는 내용이 있어요. 확인해 주세요."
fi

echo "올릴 파일 (v$v_app):"
git diff --cached --name-status | awk -F'\t' '{ print "  " ($1 == "A" ? "새 파일" : "수정   ") "  " $2 }'
if [ "${1:-}" != "-y" ]; then
  read -r -p "GitHub에 올릴까요? (y/N) " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { git reset -q; echo "올리지 않았어요."; exit 0; }
fi

# 5. Upload.
files=$(echo "$changed" | tr '\n' ' ')
git commit -q -m "v$v_app 배포: $files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q origin HEAD:main || { git reset -q --soft origin/main; die "올리지 못했어요. GitHub 로그인을 확인해 주세요 (gh auth login)."; }
green "올렸어요. 사이트에 반영되기를 기다리는 중..."

# 6. Wait until GitHub Pages serves exactly these files (usually 30초~2분).
for try in $(seq 1 12); do
  bad=0
  while IFS= read -r f; do
    [ "$(git hash-object "$f")" = "$(curl -s "$SITE/$f?t=$RANDOM$try" | git hash-object --stdin)" ] || bad=1
  done <<< "$changed"
  if [ $bad = 0 ]; then green "배포 완료: v$v_app · 폰에서 '지금 업데이트'를 눌러 주세요."; exit 0; fi
  sleep 15
done
red "올리기는 됐지만 3분 안에 사이트에 반영되지 않았어요. 잠시 뒤 다시 확인해 주세요."
