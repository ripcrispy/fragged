#!/usr/bin/env bash
# Median TTFB of key pages: scripts/perf-probe.sh <base> <username>
B=${1:-http://localhost:3300}; U=${2:-load_user_7}
J=$(mktemp); T=$(curl -s -c $J -b $J $B/login | grep -o 'name="csrf-token" content="[^"]*"' | sed 's/.*content="//;s/"//')
curl -s -o /dev/null -c $J -b $J -d "_csrf=$T&login=$U&password=${DEMO_PASSWORD:-fragged-demo-pass}" $B/login
TID=$(curl -s -b $J "$B/f/general-chat" | grep -o 'href="/t/[0-9]*-[a-z0-9-]*"' | head -1 | sed 's/href="//;s/"//')
CONV=$(curl -s -b $J -H 'accept: application/json' "$B/api/conversations" | grep -o '"publicId":"[^"]*"' | head -1 | cut -d'"' -f4)
probe() { local who=$1 path=$2; local jar=""; [ "$who" = user ] && jar="-b $J"; local ts=(); for i in 1 2 3; do ts+=($(curl -s -o /dev/null $jar -w '%{time_total}' "$B$path")); done; printf "%-5s %-46s %s\n" "$who" "$path" "$(printf '%s\n' "${ts[@]}" | sort -n | sed -n 2p)"; }
for w in guest user; do for p in / /forums /f/general-chat "/f/general-chat?page=150" "/f/general-chat?sort=views" "$TID" "$TID?page=2" /whats-new "/search?q=lighting" "/search?q=reverb&type=threads" "/members?q=load_user_1" "/u/$U"; do probe $w "$p"; done; done
for p in /messages "/messages/$CONV" /friends /notifications /api/conversations /api/friends /api/pane; do probe user "$p"; done
rm -f $J
