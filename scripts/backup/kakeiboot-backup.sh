#!/bin/bash
# kakeiboot backup構成script（TASK-83。正本の設計・手順: docs/deploy.md）
#
# 処理: 変数解決 → DB snapshot（admin backup = read-only VACUUM INTO）→
# images rsync（--deleteなし）→ COMPLETED marker / last_success → 世代
# ローテーション。各stepの対象・件数・所要はstdoutへ（unit経由でjournal）。
#
# 順序はDB→imagesで固定（設計§4-1）: 時点TのDB snapshotが参照する画像は
# T以前に実運用dirへ保存済み（backendはfile保存→DB insertの順）のため、
# backup側に参照先が欠けない。逆順はDBが参照する画像がbackup側に存在
# しなくなり得るため禁止。
#
# timestampはすべてUTCで統一する: 運用機localtimeはEtc/UTC（実測）で
# timerのOnCalendar時刻（UTC 19:30）と世代dir名（UTC日付）の対応が
# 切れないようにするため。

set -euo pipefail

# usage: kakeiboot-backup.sh <env>          # env = stg | prod
# 環境変数 KEEP=<n>（ローテーション世代数override。検証用。既定30。第1引数 <env>〔stg|prod〕とは別物）

usage() {
    echo "usage: kakeiboot-backup.sh <env>          # env = stg | prod" >&2
    echo "環境変数 KEEP=<n>（ローテーション世代数override。検証用。既定30。第1引数 <env>〔stg|prod〕とは別物）" >&2
    exit 2
}

[ "$#" -eq 1 ] || usage
env=$1
case $env in
    stg | prod) ;;
    *) usage ;;
esac

SRC=/srv/opt/tomo/run/app/tool/kakeiboot/$env
DEST=/srv/opt/tomo/run/app/tool/kakeiboot/backups/$env
STAMP=$(date -u +%F)
KEEP=${KEEP:-30}
# KEEPの数値検証: marker書込より前で失敗させる（手動実行時のタイポで
# ローテーション構文エラー→unit failed だが last_success 成功扱い、を防ぐ）
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "KEEP must be a non-negative integer (got: $KEEP)" >&2; exit 2; }

# --config-dir は運用dir相対（unitのWorkingDirectoryと同一）。直接実行時も
# 同じ解釈になるよう実行dirを運用dirへ移す。
cd "$SRC"

# backup先root: rsync・binary共に途中階層を作らないためscript冒頭で作る
# （運用手順の手動作成と二重の防護）。同日再実行は同dirへ上書き＝日次冪等。
mkdir -p "$DEST"
mkdir -p "$DEST/$STAMP"

# 1. DB: admin backup（configからdb pathを解決し、read-only openで
#    VACUUM INTO による一貫snapshotを <dest>.tmp 生成後にrename）。失敗時は
#    非ゼロexitでこのscriptも止まる（set -e）。後日のsqlite3 CLI方式への
#    切替はこのstepの1行差し替えのみで可能。
t0=$(date +%s)
"$SRC/budget-book" admin backup --dest "$DEST/$STAMP/db.sqlite" --config-dir "configs/$env"
echo "db: $DEST/$STAMP/db.sqlite ($(stat -c '%s bytes' "$DEST/$STAMP/db.sqlite"), $(( $(date +%s) - t0 ))s)"

# 2. images: append-onlyミラー（--deleteなし・追加/更新のみ。世代ローテーション
#    もしない: どの過去DB世代の参照画像も残り続ける保証）。
#    srcはconfig [maintenance] image_root の既定path前提（不在ならrsyncが
#    errorで検知する）。
t0=$(date +%s)
rsync -a --stats "$SRC/var/$env/images/" "$DEST/images/"
echo "images: $DEST/images/ ($(( $(date +%s) - t0 ))s)"

# 3. 完了marker（UTC時刻入り）と last_success（ISO8601 UTC）。このscriptの
#    途中で失敗した場合はここへ到達しない＝last_successは更新されない。
now=$(date -u +%FT%TZ)
echo "$now" > "$DEST/$STAMP/COMPLETED"
echo "$now" > "$DEST/last_success"

# 4. 世代ローテーション: COMPLETEDを持つ日付dirを新しい順に数え、KEEPを
#    超えた古いdirを削除。imagesミラーは削除しない。COMPLETEDなしの中途dir
#    （失敗時の空dir・dbのみのdir・rsync中断dir）は放置すると蓄積するため、
#    成功時に削除する。
mapfile -t gens < <(ls -1 "$DEST" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r)
kept=0
for d in "${gens[@]}"; do
    if [ -f "$DEST/$d/COMPLETED" ]; then
        if [ "$kept" -lt "$KEEP" ]; then
            kept=$((kept + 1))
        else
            rm -rf "${DEST:?}/$d"
            echo "rotation: removed generation over KEEP=$KEEP: $d"
        fi
    else
        rm -rf "${DEST:?}/$d"
        echo "rotation: removed incomplete dir (no COMPLETED): $d"
    fi
done

echo "backup $env done: $now (generations kept: $kept, KEEP=$KEEP)"
