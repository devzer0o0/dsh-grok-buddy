#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/.."
VIDEO=video/out/final.mp4
COVER=video/out/cover.png
CRED=$HOME/.dsh/bili-duty/bili_credential.json
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
SESS=$(python3 -c "import json;print(json.load(open('$CRED'))['sessdata'])")
CT=$(python3 -c "import json;print(json.load(open('$CRED'))['bili_jct'])")
BUV=$(python3 -c "import json;print(json.load(open('$CRED'))['buvid3'])")
COOKIE="SESSDATA=$SESS; bili_jct=$CT; buvid3=$BUV"
SIZE=$(stat -f%z "$VIDEO")
NAME=$(basename "$VIDEO")
PRE=$(curl -sS --max-time 30 -H "User-Agent: $UA" -H "Cookie: $COOKIE" "https://member.bilibili.com/preupload?name=$NAME&size=$SIZE&r=upos&profile=ugcfx/bup&ssl=0")
EP=$(echo "$PRE" | python3 -c "import sys,json;print(json.load(sys.stdin)['endpoint'])")
URI=$(echo "$PRE" | python3 -c "import sys,json;print(json.load(sys.stdin)['upos_uri'])")
AUTH=$(echo "$PRE" | python3 -c "import sys,json;print(json.load(sys.stdin)['auth'])")
PATHONLY=$(echo "$URI" | sed "s|^upos://||")
URL="https:$EP/$PATHONLY?os=upos&profile=ugcfx%2Fbup"
echo "URL=$URL"
UP=$(curl -sS --max-time 600 -X PUT "$URL" -H "User-Agent: $UA" -H "Cookie: $COOKIE" -H "X-Upos-Auth: $AUTH" -H "Content-Type: application/octet-stream" --data-binary "@$VIDEO" -w " HTTP:%{http_code}")
echo "UPLOAD: $(echo "$UP" | tr -d "\n" | head -c 200)"
COVERRAW=$(curl -sS --max-time 90 -X POST "https://member.bilibili.com/x/vu/web/cover/up?csrf=$CT" -H "User-Agent: $UA" -H "Cookie: $COOKIE" -F "cover=@$COVER;type=image/png" -F "csrf=$CT")
echo "COVERRAW: $(echo "$COVERRAW" | head -c 300)"
COVERURL=$(echo "$COVERRAW" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('data') or {}).get('url') or '')" 2>/dev/null)
echo "$PATHONLY" > /tmp/dsgb-filename.txt
echo "$COVERURL" > /tmp/dsgb-coverurl.txt
echo "DONE filename=$PATHONLY cover=${COVERURL:0:60}"