#!/bin/bash
# AI 難易度の強さの最終検証（Ver.0.4-B）。tools/simulate-levels.mjs をまとめて実行し、結果の JSON を OUT に保存する。
# 使い方: bash tools/validate-levels.sh OUTDIR [SEED] [SCALE]
#   SEED：調整に使った seed 1 とは別の seed で検証する（既定 2）。SCALE：組数の倍率（既定 1）。
set -e
OUT=${1:?outdir}; SEED=${2:-2}; SCALE=${3:-1}
mkdir -p "$OUT"
DIR=$(cd "$(dirname "$0")" && pwd)
run() { # name mode len a b format groups
  local g=$(( $7 * SCALE ))
  node "$DIR/simulate-levels.mjs" --mode $2 --length $3 --a $4 --b $5 --format $6 --groups $g --seed $SEED --jobs 4 > "$OUT/$1.json"
  echo "done $1"
}
for mode in math1 math2; do
  if [ $mode = math1 ]; then k=2; else k=1; fi
  for len in 4 8; do
    if [ $len = 4 ]; then h=2; else h=1; fi
    run "$mode-L$len-adv-vs-int" $mode $len advanced intermediate 1v3 $(( 75 * k * h ))
    run "$mode-L$len-beg-vs-int" $mode $len beginner intermediate 1v3 $(( 50 * k * h ))
    run "$mode-L$len-adv-vs-beg" $mode $len advanced beginner 2v2 $(( 30 * k * h ))
    for lv in beginner intermediate advanced; do
      run "$mode-L$len-same-$lv" $mode $len $lv $lv same $(( 30 * k * h ))
    done
  done
done
