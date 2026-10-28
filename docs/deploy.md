# stg・prod 運用環境（kakeiboot）

作業repo（このrepoの作業copy）での実行は dev（`mise run dev:backend`・`dev:frontend`・test・browser撮影等）まで。stg・prodの運用操作（deploy・admin CLI・service操作）は作業repoのmiseタスクから行う。タスクは処理本体 `scripts/deploy/kakeiboot_ops.py` のthin wrapperで、実行経路（ssh / local）は `configs/deploy.toml` の `transport` に従う。現行は `transport = "ssh"`（運用機 gt430 へのssh経由。運用機にrepo checkout・git操作は置かない）。実serverは運用dir上の systemd user service が担い、admin CLIはscriptが運用dirへcd（ssh時はremote cd）して実行する（運用dirはgit repoではない）。

## 構成

| 項目 | stg | prod |
|---|---|---|
| 運用dir | `<deploy_root>/stg` | `<deploy_root>/prod` |
| config | `configs/stg` | `configs/prod` |
| listen port | `configs/<env>/app.toml` `[server] port`（正本。現在 stg=40282・prod=40283） | 同左 |
| systemd unit | `kakeiboot-stg.service`（active） | `kakeiboot-prod.service`（active・enabled） |
| 外部公開 | cf-tunnel（`https://kakeiboot-stg.scioj.com`） | prod開始時に設定 |

運用dirの構成:

```
<deploy_root>/<env>/
  budget-book                        # backend binary（作業repo target/debug/budget-book・debug build）
  bin/kakeiboot-backup.sh            # backup構成script（作業repo scripts/backup/ のコピー。deployのrsyncで配布）
  configs/<env>/{app,auth,mcp}.toml  # 作業repo configs/<env>/ のコピー
  frontend/dist/                     # backendが配信するSPA shell・widget・assets
  var/<env>/                         # runtime生成（SQLite・画像）。rsync対象外
```

- backendはconfig内の相対path（`var/...`・`frontend/dist`等）を config dirの2階層上（= 運用dir自身）をrootとして解決する（`backend/src/config.rs`）。このため `configs/<env>/` の階層は上記構成から変えないこと
- migrations は binary に埋め込み（`sqlx::migrate!`）のため配布不要。tool description等もcompile時埋込み
- unit file: `~/.config/systemd/user/kakeiboot-{stg,prod}.service`。`WorkingDirectory` = 運用dir、`ExecStart` = `<運用dir>/budget-book --config-dir configs/<env>`（miseタスク `exec-<env>` と同じdir・config-dir指定）、`Restart=on-failure`
- backup用unit file: `~/.config/systemd/user/kakeiboot-backup@.{service,timer}`（template 1組で stg/prod 両用。repo正本は `scripts/systemd/`。`ExecStart` = `<運用dir>/bin/kakeiboot-backup.sh <env>`）。user configのためdeploy対象外（導入手順は「backupの導入・検証」節）
- `Environment=` の設定は不要（port・path等は configs/<env>/*.toml が正本。`RUST_LOG` を設定すれば `[log] filter` を上書きできる）

## deploy先の設定（configs/deploy.toml）

deploy先（運用dir root）の実path値と実行経路の正本は `configs/deploy.toml`。mise.toml・本doc・CLAUDE.mdは実pathを書かず、この節の `<deploy_root>` 表記で参照する。miseタスクはscript呼び出しのみで `{{vars.deploy_root}}` templateを使用しない（configの読取・合成はscriptが担う）。

**`<deploy_root>` 表記規則**: 本doc内の `<deploy_root>` は `configs/deploy.toml` の `deploy_root` 値を指すplaceholder（既存の `<env>`・`<date>`・`<port>` と同一流儀）。手順中の `<deploy_root>` は実行時に同fileの値へ読み替える。

key仕様（フラットkeyのみ。未知keyはscriptがerror〔backend configと同一流儀のtypo検出〕。TOMLのparse errorも同一形式の `error: <file>: invalid TOML: ...`（exit 2）で報告され、tracebackにはならない）:

| key | 型 | required | 意味 |
|---|---|---|---|
| `deploy_root` | string（絶対path） | 必須 | 運用dir root。stg/prod運用dir・backup dirはすべてこの値へのsuffix合成で表す。末尾に `/` を付けない（正規形。合成は常に `/` 連結） |
| `transport` | string | 必須 | 全運用操作の実行経路。`"ssh"` = `runtime_host` へのssh経由 / `"local"` = 作業機上で直接実行。省略はerror（silent defaultで `/srv/opt` 不在の中途失敗より起動時の明示errorを優先） |
| `runtime_host` | string（host alias） | `transport="ssh"`時必須 | ssh接続先のhost alias（`~/.ssh/config` のentry名。user・port・IdentityFileはssh configが正本で、scriptは `BatchMode=yes`・`ConnectTimeout=10` のみ固定付与）。`transport="local"`時は使用しない（運用機の記録として記載可・読み飛ばし） |

合成規則（`<deploy_root>` へのsuffix一覧。script・本doc共通の唯一規則）:

| 用途 | 合成文字列 |
|---|---|
| stg運用dir | `<deploy_root>/stg` |
| prod運用dir | `<deploy_root>/prod` |
| binary配布先 | `<deploy_root>/<env>/budget-book` |
| bin dir（mkdir -p宛先） | `<deploy_root>/<env>/bin` |
| backup script配布先 | `<deploy_root>/<env>/bin/kakeiboot-backup.sh` |
| config配布先 | `<deploy_root>/<env>/configs/<env>/` |
| frontend配布先 | `<deploy_root>/<env>/frontend/dist/` |
| backup root | `<deploy_root>/backups/<env>` |
| backup世代dir | `<deploy_root>/backups/<env>/<date>` |
| backup images mirror | `<deploy_root>/backups/<env>/images/` |
| last_success marker | `<deploy_root>/backups/<env>/last_success` |

`scripts/deploy/kakeiboot_ops.py` が `configs/deploy.toml`（と `configs/deploy.local.toml`）を読み、`transport` に従って全操作の実行経路を切り替える。mise.tomlはdeploy.tomlを読まない。

### local override（configs/deploy.local.toml）

作業機など運用機と異なる設定にするdeviceでは、`configs/deploy.local.toml`（git管理外）に上書きしたいkeyのみを書く:

```toml
# 例: この機械上のdirへlocal実行する検証環境
transport = "local"
# deploy_root = "<この機械の運用dir root>"  # 変更が必要な場合のみ
```

- 同じkeyを書くと後勝ちで `configs/deploy.toml` の値を上書きする（file単位の浅いmerge）。fileが存在しなければerror無くskipされる（deploy.tomlのみの環境とlocal併用環境が同一構成で動く）
- `.gitignore` の `configs/*.local.toml` 対象。commitしない
- local側に存在しないdirを指す場合、deployのrsyncは途中階層を作らないため失敗する。配布先の `<deploy_root>/<env>` 親dirを事前に作成する

## 運用操作（miseタスク・scripts/deploy/kakeiboot_ops.py）

作業repoのどこからでも実行できる（運用dirへのcd不要・gt430へのlogin不要）:

| 操作 | コマンド |
|---|---|
| deploy | `mise run stg:deploy` / `mise run prod:deploy` |
| admin CLI | `mise run exec-stg -- admin user list` / `mise run exec-prod -- admin token issue --kind setup --note "..."` |
| service操作 | `mise run stg:service -- status` / `mise run prod:service -- is-active` |
| backup手動実行 | `mise run stg:backup` / `mise run prod:backup`（timerと同一のoneshot unit。完了まで待つ） |
| backup状態確認 | `mise run stg:backup-status` / `mise run prod:backup-status`（last_success・世代dir一覧・timer・前回実行結果。**週1回**確認する） |

処理本体は `scripts/deploy/kakeiboot_ops.py`（miseタスクはthin wrapper）:

- 実行経路は `configs/deploy.toml` の `transport` に従う。`"ssh"` では全操作（rsync配布・mkdir・systemctl・healthz・file読取・binary実行）を `runtime_host` へのssh経由で実行する（rsyncは `-e "ssh -o BatchMode=yes -o ConnectTimeout=10"` + 宛先 `host:` 接頭、他は `ssh -o BatchMode=yes -o ConnectTimeout=10 <host> -- <command>` 形式。remote commandの引数はquote保持で組み立てる）。`"local"` では作業機上で直接実行する（local検証環境。`configs/deploy.local.toml` で上書きする運用）
- healthz確認のportは `configs/<env>/app.toml` `[server] port` をscript起動時に読む（mise.toml・scriptへの直書きなし。listenは `hosts = ["::"]` だがhealthzは運用機上のlocalhost宛）
- 各コマンドは実行前に `$ <command>` 形式で表示され、非零exitなら即停止して `error: <command> exited <code>` を出す（deploy失敗時は実行済みstep一覧も出力し、binary配布済み・restart前、等の状態が分かる）。command自体またはcwd（local実行時の運用dir）が存在しない場合もtracebackにならず `error: <command>: command or working directory not found` でexit 127（command-not-found code）で停止する
- dry-run（実行予定の表示のみ・転送なし・exit 0）はscriptを直接実行する:

```sh
uv run --no-project python scripts/deploy/kakeiboot_ops.py deploy --env stg --dry-run
uv run --no-project python scripts/deploy/kakeiboot_ops.py backup-status --env stg --dry-run
```

miseのflagはタスク名の前に置くこと。タスク名の後ろに置いたflagはタスクrun末尾への引数appendとして渡され、タスクがそのまま実行される（mise 2026.6.6実測の共通挙動）。現行タスクでは `mise run stg:deploy --dry-run` の `--dry-run` も結果的にscriptへ渡りscriptのdry-runとして機能するが、これはmiseの引数append挙動への依存のため、dry-runは上記の直接実行形式を使う

exec・serviceにも `--dry-run` がある（実行予定の表示のみ・budget-book・systemctlは実行しない）。この場合の置き位置は必ず `--` より前（`--` より後ろに置いた `--dry-run` はargparse REMAINDERの仕様で `--` 以降の引数への透過扱いになり、dry-runとして効かないまま実行される）:

```sh
uv run --no-project python scripts/deploy/kakeiboot_ops.py exec --env stg --dry-run -- admin user list
uv run --no-project python scripts/deploy/kakeiboot_ops.py service --env stg --dry-run -- status
```

mise経由の `mise run exec-stg --dry-run -- admin user list` 形式は機能しない: タスク名の後ろの `--dry-run` はmise自身のdry-run flag（task実行予定の表示のみ・scriptは走らない。mise 2026.6.6実測）に解釈されるため、exec・serviceのdry-runも上記のscript直接実行形式を使う

### deploy（`stg:deploy` / `prod:deploy`）

作業repoの dev にコミット済みの状態から、miseタスク（build ののち script）が以下を一括実行する:

1. build（mise `build` タスク: backend binary と `frontend/dist/`）
2. 配布 5操作（rsync 4行 + `bin/` 作成。対象・除外は下記。処理は `scripts/deploy/kakeiboot_ops.py`）
3. `systemctl --user restart kakeiboot-<env>`
4. healthz確認: `sh -c 'for i in 1 2 3 4 5; do curl -fsS http://localhost:<port>/healthz && exit 0; sleep 1; done; exit 1'`（5回retry・`<port>` は `configs/<env>/app.toml` `[server] port` の解決値。ssh時は運用機上のlocalhost宛で実行）

rsyncの対象と除外:

- 対象: backend binary（単file。`-a` で上書き）・backup script（`scripts/backup/kakeiboot-backup.sh` → `bin/kakeiboot-backup.sh`。実行権ごとcopy）・`configs/<env>/`（`--delete` で完全同期）・`frontend/dist/`（`--delete` で旧hash付きassetを掃除）
- 除外: `var/`（runtimeデータ。`--delete` を運用dir全体に向けない）
- rsyncは途中階層を作らないため、初回は `configs/`・`frontend/`・`bin/` の親dirを先に作成する（deployタスクが `bin/` の `mkdir -p` を含む）

### 運用 CLI（`exec-stg` / `exec-prod`）

運用dir上で `./budget-book admin <args> --config-dir configs/<env>` を実行する。scriptが運用dirへcdする（localは実行dir指定・sshは `cd <deploy_root>/<env> && ...` のremote実行。旧タスクの `dir` 属性から移行）。subcommand・flagは `--` 以降にそのまま渡す（空白・記号入り引数はquote保持）。passkey紛失時の再登録URL発行（token plaintextは1回だけ表示・監査対象外）:

```sh
mise run exec-prod -- admin token issue --kind setup --note "家族用"
mise run exec-stg -- admin user list
mise run exec-stg -- admin user show <user>
```

### service操作（`stg:service` / `prod:service`）

`systemctl --user <verb> kakeiboot-<env>` に対応する:

```sh
mise run stg:service -- status
mise run stg:service -- is-active
mise run prod:service -- enable --now
```

## データの所在とbackup・復元

backendが扱う永続データとその所在（configは相対path指定を運用dir rootで解決。`backend/src/config.rs`）:

| データ | 場所 | 備考 |
|---|---|---|
| SQLite DB | `var/<env>/db.sqlite` | WAL + synchronous=NORMAL 運用（`backend/src/db.rs`）。書込直後は `db.sqlite-wal` / `db.sqlite-shm` が併存する |
| 画像ファイル | `var/<env>/images/YYYY/MM/<ulid>.webp` | `[maintenance] image_root`。DBの `images.storage_path` と対応 |
| config | `configs/<env>/{app,auth,mcp}.toml` | git管理。deploy時にrsync（`--delete`） |

deployのrsyncは `var/` を対象外とするため、deployでruntimeデータが書き換わることはない（dbへのtouchはrestart時のmigration適用のみ）。

### backup（自動backup・TASK-83）

**毎日自動実行**: systemd user timer（`kakeiboot-backup@<env>.timer`）が **UTC 19:30（= JST 04:30 翌日）** に oneshot service `kakeiboot-backup@<env>` を起動し、運用dir配下の `bin/kakeiboot-backup.sh`（repo正本: `scripts/backup/`。deployで配布）がbackupを編成する。進捗・失敗はjournal（`journalctl --user -u kakeiboot-backup@<env>`）に出る。`Persistent=true`（停電・停止後の取り戻し）と `RandomizedDelaySec=15m`（stg/prodのIO競合緩和）付き。

scriptの処理（この順序で固定）:

1. **DB**: `budget-book admin backup --dest <backup先>/<date>/db.sqlite --config-dir configs/<env>`。dbを read-only open（`create_if_missing(false)`・migration不実行。path誤りで空DBを作らない）して `VACUUM INTO` で**単一時点の整合snapshot**（単一file）を生成。`VACUUM INTO` はWAL readerとして動作するため並行writerをブロックせず、**WAL運用中の稼働中取得でも未checkpointの書込が失われない**（`db.sqlite` 単体copyとの違い。これがonline backup必須の根拠）
2. **images**: `rsync -a var/<env>/images/ <backup先>/images/`（`--delete`なしの追加/更新のみ）
3. **完了marker・last_success**: 世代dirに `COMPLETED`（UTC時刻入り）、backup先rootに `last_success`（ISO8601 UTC）。失敗時はここへ到達しないため `last_success` は更新されない
4. **世代ローテーション**: `COMPLETED` を持つ日付dirを新しい順に `KEEP`（既定30）世代まで保持し、超過分を `rm -rf`。`COMPLETED` なしの中途dir（失敗残留）は次回成功時に削除。imagesミラーは削除しない

backup先と構成:

- backup先root: `<deploy_root>/backups/<env>/`（運用dirの外・同一disk。運用dir再作成・誤操作の影響を受けない最後の砒）
- `backups/<env>/<date>/db.sqlite`: 日次世代dir（UTC日付。同日再実行は同dirへ上書き＝冪等）
- `backups/<env>/images/`: append-only単一ミラー（世代ローテーションなし。orphan cleanupで実運用dirから消えた画像も残るが無害）
- 対象外: configs（git管理・deployでrsync）・frontend/dist（build成果物）・binary

**同一時点性の順序根拠**: 時点TのDB snapshotが参照する画像はT以前に実運用dirへ保存済み（backendはfile保存→DB insertの順で書く）のため、「DB snapshot → images rsync」の順ならbackup側にDBが参照する画像が欠けることがない。逆順（images先→DB後）はDB(T2)が参照するT1〜T2追加画像がbackup側に存在しなくなり得るため禁止。手動で個別にcopyする場合も必ずこの順序で行うこと。

**稼働確認**: `mise run <env>:backup-status` で **週1回**確認する（`last_success` の日付・世代dirの並び・timer・前回実行Result）。通知経路（mail・IM等）は無いため、能動確認まで失敗・長期停止に気付けない。

**server停止中・異常停止直後のbackup取得**: `admin backup` の read-only open は `-shm` fileが利用できない状況（server停止中・異常停止直後）で失敗し得る（SQLiteの制約。timer実行時はserver稼働中のため通常起きない）。停止時にbackupを取得する場合は下記の旧来の3点copy手順を使う（異常時手段として残す）:

- `mise run <env>:service -- stop` → `var/<env>/db.sqlite{,-wal,-shm}` の3点をそのままcopy → start

なお `sqlite3` CLIは運用機に存在しない（2026-10-22実測）。DB snapshot取得は `admin backup` subcommandを正とする（`mise run exec-<env> -- admin backup --dest <file>` でも手動実行可）。

### 復元

1. `mise run <env>:service -- stop`
2. `var/<env>/db.sqlite{,-wal,-shm}` を削除し、backup世代dirの `backups/<env>/<date>/db.sqlite`（単一file snapshotのため `-wal`/`-shm` は不要）を `var/<env>/db.sqlite` へcopy
3. 画像がある場合は `backups/<env>/images/` を `var/<env>/images/` へcopy（imagesミラーは全世代共通。`COMPLETED` markerのある世代dirのdbと組み合わせる）
4. `mise run <env>:service -- start`（起動時migrationが新版を適用）

（backup導入前の旧backup・3点copyで採ったものを戻す場合は `db.sqlite{,-wal,-shm}` の3点とも戻す）

### backupの導入・検証

stg→prodの順で、repoのdeploy・mise経由で行う（運用機へのpackage install不要・運用機上の操作はすべてssh実行形。`<deploy_root>` は configs/deploy.toml の `deploy_root` 値に読み替える）:

1. `mise run stg:deploy`（binary〔`admin backup` 入〕と `bin/kakeiboot-backup.sh` を配布。ssh経由）
2. backup先dir作成（運用機上）: `ssh gt430 'mkdir -p <deploy_root>/backups/{stg,prod}'`（`{stg,prod}` はremote shellのbrace expansion。script側でも `$DEST` を作るが、明示手順として残す）
3. unit配置（user config dirはdeploy配布対象外のため手動）: `scp scripts/systemd/kakeiboot-backup@.service scripts/systemd/kakeiboot-backup@.timer gt430:.config/systemd/user/ && ssh gt430 systemctl --user daemon-reload`
4. timer有効化: `ssh gt430 systemctl --user enable --now kakeiboot-backup@stg.timer`（ssh非対話実行で `systemctl --user` がXDG_RUNTIME_DIR不在により失敗する環境では `ssh gt430 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user ...'` の形式を使う）
5. 初回実行と確認: `mise run stg:backup` を実行し、(1) journal（`ssh gt430 journalctl --user -u kakeiboot-backup@stg`）に各stepの対象・件数・所要が出る (2) 世代dir `backups/stg/<date>/db.sqlite` と `COMPLETED` が存在（`mise run stg:backup-status`） (3) `last_success` が更新、の3点を確認。失敗注入（backup先を読み取り専用にする等）でunit failedがjournalに残り`last_success`が更新されないこと・権限復旧後の再実行で回復することも確認する。復元手順を実際に実施してserverが起動し画像配信で404が出ないことを確認してから、prodへ同一手順（prod適用はユーザー承認を経る）

なおweb設定画面のデータtabの書き出し・取り込み（`spec_mcp-tools.md` §12）は**利用者向けのデータ持ち出し・復帰**であり、運用backup（認証系・全ledgerを含む全体像・世代管理）の代替にはならない。

## prodの運用

prodはstgと同じ体制で配備・稼働している（unit: enabled・active）。main branchでの運用開始時も `mise run prod:deploy` で main の成果物を prod 運用dirへ配備する。

## マシン起動時の自動起動（linger）

user service をマシン起動時（ログイン前）に起動するには linger が必要。`loginctl enable-linger tomo` 済み（確認: `loginctl show-user tomo --property=Linger` → `Linger=yes`）。backup timer（`kakeiboot-backup@<env>.timer`）も同じく linger が必要（timer発火がloginに依存しない。lingerが無いとbackupが静止する）。
