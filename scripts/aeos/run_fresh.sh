#!/bin/bash
# usage: run_fresh.sh <label> <repo-dir> <branch> <prompt> [pre-command]
S=/tmp/claude-0/-home-user/1d924ba0-a18e-57f8-84fc-f893423fec7f/scratchpad
label=$1; repo=$2; branch=$3; prompt=$4; pre=$5
d=$S/fresh/$label; rm -rf "$d"; git clone -q --branch "$branch" "$repo" "$d" || exit 1
cd "$d"; git config user.email t@t; git config user.name t
[ -n "$pre" ] && eval "$pre"
start=$(date +%s)
timeout 300 claude -p "$prompt" --permission-mode plan --allowedTools Read --max-turns 8 --output-format json > $S/fresh/out/$label.json 2> $S/fresh/out/$label.err
echo "rc=$? secs=$(( $(date +%s)-start )) head=$(git rev-parse --short HEAD)" > $S/fresh/out/$label.meta
