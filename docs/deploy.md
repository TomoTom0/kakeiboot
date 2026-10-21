# stg・prod 運用環境（kakeiboot）

作業repo（`/home/tomo/work/app/tool/budget-book`）での実行は dev（`mise run dev:backend`・`dev:frontend`・test・browser撮影等）まで。stg・prodの運用操作（deploy・admin CLI・service操作）は作業repoのmiseタスク（mise.toml）から行う。実serverは運用dir上の systemd user service が担い、admin CLIはタスクの `dir` 指定で運用dir上で実行する（運用dirはgit repoではない）。

## 構成

| 項目 | stg | prod |
|---|---|---|
| 運用dir | `/srv/opt/tomo/run/app/tool/kakeiboot/stg` | `/srv/opt/tomo/run/app/tool/kakeiboot/prod` |
| config | `configs/stg` | `configs/prod` |
| listen port | 40282 | 40283 |
| systemd unit | `kakeiboot-stg.service`（active） | `kakeiboot-prod.service`（active・enabled） |
| 外部公開 | cf-tunnel（`https://kakeiboot-stg.scioj.com`） | prod開始時に設定 |

運用dirの構成:

```
/srv/opt/tomo/run/app/tool/kakeiboot/<env>/
  budget-book                        # backend binary（作業repo target/debug/budget-book・debug build）
  configs/<env>/{app,auth,mcp}.toml  # 作業repo configs/<env>/ のコピー
  frontend/dist/                     # backendが配信するSPA shell・widget・assets
  var/<env>/                         # runtime生成（SQLite・画像）。rsync対象外
```

- backendはconfig内の相対path（`var/...`・`frontend/dist`等）を config dirの2階層上（= 運用dir自身）をrootとして解決する（`backend/src/config.rs`）。このため `configs/<env>/` の階層は上記構成から変えないこと
- migrations は binary に埋め込み（`sqlx::migrate!`）のため配布不要。tool description等もcompile時埋込み
- unit file: `~/.config/systemd/user/kakeiboot-{stg,prod}.service`。`WorkingDirectory` = 運用dir、`ExecStart` = `<運用dir>/budget-book --config-dir configs/<env>`（miseタスク `exec-<env>` と同じdir・config-dir指定）、`Restart=on-failure`
- `Environment=` の設定は不要（port・path等は configs/<env>/*.toml が正本。`RUST_LOG` を設定すれば `[log] filter` を上書きできる）

## 運用操作（miseタスク）

作業repoのどこからでも実行できる（運用dirへのcd不要）:

| 操作 | コマンド |
|---|---|
| deploy | `mise run stg:deploy` / `mise run prod:deploy` |
| admin CLI | `mise run exec-stg -- admin user list` / `mise run exec-prod -- admin token issue --kind setup --note "..."` |
| service操作 | `mise run stg:service -- status` / `mise run prod:service -- is-active` |

miseのflagはタスク名の前に置くこと。タスク名の後ろに置いたflag（例: `mise run stg:deploy --dry-run`）はタスクへの引数扱いになり、タスクがそのまま実行される（mise共通の挙動）。

### deploy（`stg:deploy` / `prod:deploy`）

作業repoの dev にコミット済みの状態から、以下を一括実行する:

1. build（`build` タスク: backend binary と `frontend/dist/`）
2. rsync 3行（対象・除外は下記）
3. `systemctl --user restart kakeiboot-<env>`
4. `curl -fsS http://localhost:<port>/healthz`（stg=40282・prod=40283）で起動確認

rsyncの対象と除外:

- 対象: backend binary（単file。`-a` で上書き）・`configs/<env>/`（`--delete` で完全同期）・`frontend/dist/`（`--delete` で旧hash付きassetを掃除）
- 除外: `var/`（runtimeデータ。`--delete` を運用dir全体に向けない）
- rsyncは途中階層を作らないため、初回は `configs/`・`frontend/` の親dirを先に作成する

### 運用 CLI（`exec-stg` / `exec-prod`）

運用dir上で `./budget-book admin <args> --config-dir configs/<env>` を実行する。subcommand・flagは `--` 以降にそのまま渡す。passkey紛失時の再登録URL発行（token plaintextは1回だけ表示・監査対象外）:

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

### backup

**自動backup機構は現状存在しない**（timer・cron・admin CLI・app機能のいずれにも無い。2026-10-19時点の実測）。障害時に失えるため、必要になった時点で以下のいずれかで取得する:

- **停止時**: `var/<env>/db.sqlite{,-wal,-shm}` の3点をそのままcopy
- **稼働中（online）**: `sqlite3 var/<env>/db.sqlite ".backup <dest>"` または `VACUUM INTO`（SQLite公式のonline backup。一貫した単file snapshotになり、WALの併存fileを考慮しなくてよい。sqlite3 CLIが運用機で利用可能）
- 画像がある場合は `var/<env>/images/` を同一時点にcopy/tar

WAL運用のため **`db.sqlite` 単体のcopyでは未checkpointの書込が失われる**（3点copyかonline backup APIを使う）。DBと画像ファイルは別々のタイミングで更新されるため、**同一時点の組で採らないとDBに登録された画像pathの実ファイルが無い状態（配信404）が起こり得る**。

### 復元

1. `mise run <env>:service -- stop`
2. `var/<env>/db.sqlite{,-wal,-shm}` をbackupから戻す（3点とも。online backupで取った単fileの場合はdb.sqliteのみでよく、旧 `-wal`/`-shm` が残っていれば削除する）
3. `var/<env>/images/` を戻す（画像がある場合）
4. `mise run <env>:service -- start`（起動時migrationが新版を適用）

なおweb設定画面のデータtabの書き出し・取り込み（`spec_mcp-tools.md` §12）は**利用者向けのデータ持ち出し・復帰**であり、運用backup（認証系・全ledgerを含む全体像・世代管理）の代替にはならない。

## prodの運用

prodはstgと同じ体制で配備・稼働している（unit: enabled・active）。main branchでの運用開始時も `mise run prod:deploy` で main の成果物を prod 運用dirへ配備する。

## マシン起動時の自動起動（linger）

user service をマシン起動時（ログイン前）に起動するには linger が必要。`loginctl enable-linger tomo` 済み（確認: `loginctl show-user tomo --property=Linger` → `Linger=yes`）。
