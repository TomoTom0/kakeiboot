# stg・prod 運用環境（kakeiboot）

作業repo（このrepoの作業copy）での実行は dev（`mise run dev:backend`・`dev:frontend`・test・browser撮影等）まで。stg・prodの運用操作（deploy・promote・configs配布・admin CLI・service操作）は作業repoのmiseタスクから行う。タスクは処理本体 `scripts/deploy/kakeiboot_ops.py` のthin wrapperで、実行経路（ssh / local）は `configs/deploy.toml` の `transport` に従う。現行は `transport = "ssh"`（運用機 gt430 へのssh経由。運用機にrepo checkout・git操作は置かない）。実serverは運用dir上の systemd system service（kakeiboot-stg / kakeiboot-prod）が担い、admin CLIはscriptが運用dirへcd（ssh時はremote cd）して実行する（運用dirはgit repoではない）。

## 構成

| 項目 | stg | prod |
|---|---|---|
| 運用dir | `<deploy_root>/stg` | `<deploy_root>/prod` |
| config | `configs/stg` | `configs/prod` |
| listen port | `configs/<env>/app.toml` `[server] port`（正本。現在 stg=40282・prod=40283） | 同左 |
| systemd unit | `kakeiboot-stg.service`（active） | `kakeiboot-prod.service`（active・enabled） |
| 外部公開 | cf-tunnel（`https://kakeiboot-stg.scioj.com`） | cf-tunnel（`https://kakeiboot.scioj.com`） |

運用dirの構成:

```
<deploy_root>/<env>/
  budget-book                        # backend binary（作業repo target/debug/budget-book・debug build）
  bin/kakeiboot-backup.sh            # backup構成script（作業repo scripts/backup/ のコピー。deployのrsyncで配布）
  configs/<env>/{app,auth,mcp}.toml  # 作業repo configs/<env>/ のコピー
  frontend/dist/                     # backendが配信するSPA shell・widget・assets
  releases/<UTC timestamp>/          # promoteが配布前に旧成果物（binary・bin/・frontend/）を退避（prodのみ）
  var/<env>/                         # runtime生成（SQLite・画像）。rsync対象外
```

- backendはconfig内の相対path（`var/...`・`frontend/dist`等）を config dirの2階層上（= 運用dir自身）をrootとして解決する（`backend/src/config.rs`）。このため `configs/<env>/` の階層は上記構成から変えないこと
- migrations は binary に埋め込み（`sqlx::migrate!`）のため配布不要。tool description等もcompile時埋込み
- unit file: `/etc/systemd/system/kakeiboot-{stg,prod}.service`（system service。実行userは stg=muse-agent・prod=tomo。tomo / muse-agent の双方が polkit ルールにより自分の身分で操作できる）。`WorkingDirectory` = 運用dir、`ExecStart` = `<運用dir>/budget-book --config-dir configs/<env>`（miseタスク `exec-<env>` と同じdir・config-dir指定）、`Restart=on-failure`
- backup用unit file: `~/.config/systemd/user/kakeiboot-backup@.{service,timer}`（template 1組で stg/prod 両用）。repo正本は `scripts/systemd/kakeiboot-backup@.service.in`（`{{deploy_root}}` placeholder入り。timerはpathを含まないためrender対象外）で、`mise run units:install` が `configs/deploy.toml` の `deploy_root` 値でrenderした実体をuser config dir（無ければ作成）へ配布する（`ExecStart` = `<deploy_root>/<env>/bin/kakeiboot-backup.sh <env>`）。user configのためdeploy対象外（導入手順は「backupの導入・検証」節）
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
| promote配布元 binary | `<deploy_root>/stg/budget-book` |
| promote配布元 backup script | `<deploy_root>/stg/bin/kakeiboot-backup.sh` |
| promote配布元 frontend | `<deploy_root>/stg/frontend/dist/` |
| 旧成果物退避dir（promote） | `<deploy_root>/prod/releases/<timestamp>` |
| backup root | `<deploy_root>/backups/<env>` |
| backup世代dir | `<deploy_root>/backups/<env>/<date>` |
| backup images mirror | `<deploy_root>/backups/<env>/images/` |
| last_success marker | `<deploy_root>/backups/<env>/last_success` |

backup script（`scripts/backup/kakeiboot-backup.sh`）内の `SRC`（= 運用dir）・`DEST`（= backup root）もこの表と同一規則で、実pathをscriptに書かず配布位置から導出する: script自身（`bin/kakeiboot-backup.sh`）の2階層上が `<deploy_root>`（deploy配布契約 `<deploy_root>/<env>/bin/kakeiboot-backup.sh` 由来。repo正本を直接実行した場合も実行元の配置dir基準で動き、誤環境への書込が起きない）。

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
| deploy（stg） | `mise run stg:deploy`（build → repo成果物をstgへ配布 → restart → healthz） |
| promote（stg→prod） | `mise run prod:promote`（stg運用dirの検証済み成果物をprodへ配布。詳細は「promote」節） |
| configs配布 | `mise run prod:configs`（repo `configs/prod/` → prod運用dir。詳細は「configs」節） |
| admin CLI | `mise run exec-stg -- admin user list` / `mise run exec-prod -- admin token issue --kind setup --note "..."` |
| service操作 | `mise run stg:service -- status` / `mise run prod:service -- is-active` |
| backup手動実行 | `mise run stg:backup` / `mise run prod:backup`（timerと同一のoneshot unit。完了まで待つ） |
| backup状態確認 | `mise run stg:backup-status` / `mise run prod:backup-status`（last_success・世代dir一覧・timer・前回実行結果。**週1回**確認する） |
| backup unit配布 | `mise run units:install`（unit正本 `.in` を `deploy_root` でrenderしuser config dir作成・配布・`daemon-reload`まで。unitは `%i` template 1組でenv非依存のため接頭は `units:`。導入手順は「backupの導入・検証」節） |

処理本体は `scripts/deploy/kakeiboot_ops.py`（miseタスクはthin wrapper）:

- 実行経路は `configs/deploy.toml` の `transport` に従う。`"ssh"` では全操作（rsync配布・mkdir・systemctl・healthz・file読取・binary実行）を `runtime_host` へのssh経由で実行する（rsyncは `-e "ssh -o BatchMode=yes -o ConnectTimeout=10"` + 宛先 `host:` 接頭、他は `ssh -o BatchMode=yes -o ConnectTimeout=10 <host> -- <command>` 形式。remote commandの引数はquote保持で組み立てる）。`"local"` では作業機上で直接実行する（local検証環境。`configs/deploy.local.toml` で上書きする運用）
- healthz確認のportは `configs/<env>/app.toml` `[server] port` をscript起動時に読む（mise.toml・scriptへの直書きなし。listenは `hosts = ["::"]` だがhealthzは運用機上のlocalhost宛）。deployはrepoのconfigsから解決し、promoteは運用dirに配布済みのconfigsから解決する（promoteの全挙動がrepo configと独立するため）
- 各コマンドは実行前に `$ <command>` 形式で表示され、非零exitなら即停止して `error: <command> exited <code>` を出す（deploy失敗時は実行済みstep一覧も出力し、binary配布済み・restart前、等の状態が分かる）。command自体またはcwd（local実行時の運用dir）が存在しない場合もtracebackにならず `error: <command>: command or working directory not found` でexit 127（command-not-found code）で停止する
- dry-run（実行予定の表示のみ・転送なし・exit 0）は全タスクで `mise run <task> -- --dry-run` 形式で使える（exec・serviceのdry-runでは実行予定の表示のみでbudget-book・systemctlは実行しない。promoteのdry-runは配布stepを実行しないが、port解決〔運用dirconfigの読み取り・ssh時はremote cat 2回〕を読み取り専用のplan構築前段として実行する。ssh接続不能時にdry-runも失敗するのは事前発見として有益）:

```sh
mise run stg:deploy -- --dry-run
mise run stg:backup-status -- --dry-run
mise run exec-stg -- --dry-run admin user list
mise run stg:service -- --dry-run status
mise run units:install -- --dry-run
```

`units:install --dry-run` はrender後のunit内容（`{{deploy_root}}` 置換済み）に続けて実行予定の `$ <command>` 行を表示し、dir作成・file作成・配布・reloadは行わない（renderに使う `deploy_root` 値も出力される。plan中のrender済みfile pathは表示用であり、実行時は `tmp/units-*` の一時dirにstagingされる）

`--` はmise自身のflagとタスクへの引数の区切りとして1個だけ使う。`--` を挟まない `mise run exec-stg --dry-run -- admin user list` 形式は機能しない: タスク名の後ろの `--dry-run` はmise自身のdry-run flag（task実行予定の表示のみ・scriptは走らない。mise 2026.6.6実測）に解釈される

- deploy・promote・configs・backup・backup-statusタスクでは `--` 以降のargsがコマンド末尾へ渡り `--dry-run` がscriptのdry-run flagになる（`mise run stg:deploy -- --dry-run` → `deploy --env stg --dry-run`。`mise run prod:promote -- --dry-run`・`mise run prod:configs -- --preview`〔rsync自身のdry-runによる差分表示〕も同形）
- exec・serviceタスクでは `--` 以降のargsが `${usage_args}` / `${usage_verb}` の位置へ展開される。タスクrun文字列に `--` を含めないため、`mise run exec-stg -- --dry-run admin user list` はscriptへ `exec --env stg --dry-run admin user list` として渡り、先頭の `--dry-run` がscriptのdry-run flagとして解釈され `admin user list` がbudget-bookへの引数になる（scriptを直接実行する場合は `--dry-run` を `--` より前に置く。`--` より後ろに置いた `--dry-run` はargparse REMAINDERの仕様で透過扱いになり、dry-runとして効かないまま実行される）

### deploy（`stg:deploy`・stg向け）

作業repoの dev にコミット済みの状態から、miseタスク（build ののち script）が以下を一括実行する（prodへの直接deployは無い。prodへの配布はpromote経路のみ）:

1. build（mise `build` タスク: backend binary と `frontend/dist/`）
2. 配布 5操作（rsync 4行 + `bin/` 作成。対象・除外は下記。処理は `scripts/deploy/kakeiboot_ops.py`）
3. `systemctl restart kakeiboot-stg`
4. healthz確認: `sh -c 'for i in 1 2 3 4 5; do curl -fsS http://localhost:<port>/healthz && exit 0; sleep 1; done; exit 1'`（5回retry・`<port>` はrepo `configs/stg/app.toml` `[server] port` の解決値。ssh時は運用機上のlocalhost宛で実行）

rsyncの対象と除外:

- 対象: backend binary（単file。`-a` で上書き）・backup script（`scripts/backup/kakeiboot-backup.sh` → `bin/kakeiboot-backup.sh`。実行権ごとcopy）・`configs/stg/`（`--delete` で完全同期）・`frontend/dist/`（`--delete` で旧hash付きassetを掃除）
- 除外: `var/`（runtimeデータ。`--delete` を運用dir全体に向けない）
- rsyncは途中階層を作らないため、初回は `configs/`・`frontend/`・`bin/` の親dirを先に作成する（deployタスクが `bin/` の `mkdir -p` を含む）

### promote（`prod:promote`）

stg検証済み成果物をprodへ配布する。**配布元はstg運用dirの現物**（binary・`frontend/dist/`・backup script）で、repoのbuild成果物は参照しない（miseタスクのdependsなし = buildしないことがpromoteの本体）。stgで実際に稼働している現物がそのままprodへ入るため、検証対象と配布対象の同一性が人間の規律ではなく経路構造で担保される（stg検証からpromoteまでの間の作業repo変更はprodへ影響しない）。

標準手順: `mise run stg:deploy` → stg実機検証 → `mise run prod:backup`（rollback前提の直近backup取得）→ `mise run prod:promote`。

処理（`scripts/deploy/kakeiboot_ops.py promote`。11 step固定順序。step1-4はprodへ書き込まない読み取り専用で、失敗してもprod側に影響を残さない）:

1. stg前段チェック1: stg healthz（5回retry。portは **stg運用dir** の配布済み `configs/stg/app.toml` から解決）
2. stg前段チェック2: 稼働プロセスの実行binaryとstg運用dir binaryのsha256照合（pidは `systemctl show kakeiboot-stg -p MainPID`・`/proc/<pid>/exe` のhashとdisk上 `<stg>/budget-book` のhashを比較。「binary配布済み・restart前/失敗で稼働が旧プロセスのまま」の中途状態を排除。rsync `-a` がmtimeを保持するため起動時刻×mtime比較ではこの状態を検出できない。systemctl失敗・PID空・`/proc` 読み取り不可・hash不一致はすべて非零で停止するfail-closed構成。stgはsystem service（User=muse-agent）として稼働し、現行のssh運用者も同一userのため`/proc/<pid>/exe`は読み取り可）
3. binaryのsha256表示（stg側は失敗=停止。prod側はfile不在時 `prod: budget-book not deployed yet` を表示して続行 = 初回構築可能）
4. configs乖離の補助表示（repo `configs/prod/` → prod運用dirへの転送なしpreview）
5. 旧成果物退避: prod側binary存在時のみ `<deploy_root>/prod/releases/<UTC timestamp>/` へ binary・`bin/`・`frontend/` を運用機上copy（全操作を `&&` 連結で実行し・date・mkdir・cpのいずれかの失敗はstep全体の非零=promote停止。不在時はskip）
6. `mkdir -p <deploy_root>/prod/{bin,frontend,configs/prod}`（rsyncは途中階層を作らないため前提dirを機構側で用意）
7. rsync（運用機上）stg運用dir binary → prod binary（`-a --checksum -i`）
8. rsync（運用機上）stg運用dir backup script → `prod/bin/`（`-a --checksum -i`）
9. rsync（運用機上）stg運用dir `frontend/dist/` → `prod/frontend/dist/`（`-a --delete -i`）
10. `systemctl restart kakeiboot-prod`
11. healthz（portは **prod運用dir** の配布済み `configs/prod/app.toml` から解決）

- **configsはpromoteの配布対象に含まない**（環境定義は設定変更時のみ明示更新する。毎回の置き換えは未検証変更の混入余地になる）。step4は乖離の注意喚起表示のみであり、乖離の事前確認の正経路は **`mise run prod:configs -- --preview`**（promote内の表示からコピー開始までに判断の余白がないため、独立した確認操作で判断する）
- 前段チェック（step1-2）は「stg運用dirの現物がそのままprodへ入る」ことの機械確認であって、**stgで人間による検証（実機確認・MCP実操作等）が行われたことの担保ではない**。検証実施の判断は運用者に残る
- **promote実行中は `stg:deploy` を並行実行しない**（配布元のstg運用dirが並行deployで書き換わると検証対象と配布対象の同一性が崩れる。単一運用者の手動運用が実態のため機械的排他〔flock等〕は設けない）
- 途中失敗時は実行済みstep一覧が報告される。全stepは冪等（rsync収束・`mkdir -p`・退避はtimestamp付き別dirが新たに作られるのみ）のため、原因確認後に同じコマンドを再実行するのが原則（step数×失敗位置の部分復元手順は作らない）

**退避とrollback**: step5で旧binary・`bin/`・`frontend/`（dist含む）を退避する（旧distは `--delete` 同期でprodから消え、stg運用dirにも現行しか残らないため退避が唯一の復元元）。rollback手順:

1. `mise run prod:service -- stop`
2. 退避dir（`releases/<timestamp>/`）の `budget-book`・`bin/`・`frontend/` を `<deploy_root>/prod/` へ戻す（運用機上copy。sshでの実行）
3. `mise run prod:service -- start`（起動後healthzを確認）

退避dirの自動世代管理（KEEP N・超過削除）は設けない（promoteは低頻度運用で増殖が遅く、管理機構に見合わない）。不要になった退避dirの削除は運用者の判断。migrationを含むpromoteの失敗でDBを旧状態へ戻す必要が生じた場合は、事前取得の `prod:backup` 世代から復元する（「復元」節。旧binary×新schemaのDB互換性は保証されない）。

### configs（`prod:configs`）

repo `configs/<env>/`（git管理の正本）を運用dir `configs/<env>/` へ配布する独立操作（`scripts/deploy/kakeiboot_ops.py configs --env <env>`。scriptは両env対応・miseタスクはprod側のみ）。手順は `mkdir -p` + `rsync -a --delete --checksum -i` の2 stepのみで、**restart・healthzを含まない**（backendはconfigを起動時に1回読み込みreload機構が無いため、configs操作がrestartを内蔵すると旧binary×新configsの組で起動する機会を機構的に増やす。反映はpromoteのrestartまたは明示的なservice操作が担う）:

- 設定変更のみのrelease: `mise run prod:configs` → `mise run prod:service -- restart`
- 設定変更を含む成果物release: `mise run prod:configs` → `mise run prod:promote`（promoteのrestartで新binary×新configsの組が揃うことが原則）

原則どおりにいかない経路として、configs配布からpromoteのrestartまでの間に、`Restart=on-failure` による自動再起動や backup timer の起動で旧binaryが新configsを読んで起動しうる（互換性を壊すschema変更の場合はconfigs配布からpromote完了までの窓を最小化する運用・状況に応じてbackup timerの一時停止を検討する）。

乖離の事前確認は `mise run prod:configs -- --preview`（rsync自身の `--dry-run` で転送なしの差分実体を表示。scriptの `--dry-run`〔plan表示のみ〕とは別物）。

### 運用 CLI（`exec-stg` / `exec-prod`）

運用dir上で `./budget-book admin <args> --config-dir configs/<env>` を実行する。scriptが運用dirへcdする（localは実行dir指定・sshは `cd <deploy_root>/<env> && ...` のremote実行。旧タスクの `dir` 属性から移行）。subcommand・flagは `--` 以降にそのまま渡す（空白・記号入り引数はquote保持）。passkey紛失時の再登録URL発行（token plaintextは1回だけ表示・監査対象外）:

```sh
mise run exec-prod -- admin token issue --kind setup --note "家族用"
mise run exec-stg -- admin user list
mise run exec-stg -- admin user show <user>
```

### service操作（`stg:service` / `prod:service`）

`systemctl <verb> kakeiboot-<env>` に対応する:

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
| config | `configs/<env>/{app,auth,mcp}.toml` | git管理。`stg:deploy`（stg）・`prod:configs`（prod）でrsync（`--delete`） |

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
3. unit配置: `mise run units:install`（repo正本 `scripts/systemd/kakeiboot-backup@.service.in` を `configs/deploy.toml` の `deploy_root` でrenderし、user config dirを作成の上render済みserviceとtimerをrsync・`systemctl --user daemon-reload` まで一括実行。`.in` は `{{deploy_root}}` placeholder入りのため直接scp禁止）。配布後は `ssh gt430 systemctl --user cat kakeiboot-backup@stg.service` で内容ベース確認: `WorkingDirectory=` / `ExecStart=` の2行が `<deploy_root>/%i`・`<deploy_root>/%i/bin/kakeiboot-backup.sh %i`（deploy.tomlの解決値）と一致すること・既存行に差分が無いこと（初回差し替え時の期待差分は `.in` 冒頭のcomment行のみ）
4. timer有効化: `ssh gt430 systemctl --user enable --now kakeiboot-backup@stg.timer`（ssh非対話実行で `systemctl --user` がXDG_RUNTIME_DIR不在により失敗する環境では `ssh gt430 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user ...'` の形式を使う）
5. 初回実行と確認: `mise run stg:backup` を実行し、(1) journal（`ssh gt430 journalctl --user -u kakeiboot-backup@stg`）に各stepの対象・件数・所要が出る (2) 世代dir `backups/stg/<date>/db.sqlite` と `COMPLETED` が存在（`mise run stg:backup-status`） (3) `last_success` が更新、の3点を確認。失敗注入（backup先を読み取り専用にする等）でunit failedがjournalに残り`last_success`が更新されないこと・権限復旧後の再実行で回復することも確認する。復元手順を実際に実施してserverが起動し画像配信で404が出ないことを確認してから、prodへ同一手順（prod適用はユーザー承認を経る）

なおweb設定画面のデータtabの書き出し・取り込み（`docs/spec/spec_mcp-tools.md` §12）は**利用者向けのデータ持ち出し・復帰**であり、運用backup（認証系・全ledgerを含む全体像・世代管理）の代替にはならない。

## prodの運用

prodはstgと同じ体制で配備・稼働している（unit: enabled・active）。prodへの成果物配布は `mise run prod:promote`（stg運用dirの検証済み現物を配布。repoのbuildは介さない）。prod初回構築・新運用機への再構築時は **`prod:configs`（configs初回配布）→ `prod:promote`（成果物配布・restart・healthz）の順**で行う（promoteはconfigsを配布しないため初回はconfigsが必須。promote側もprod未配備〔binary不在〕を許容するため手順が成立する）。

## マシン起動時の自動起動（linger）

stg・prod の system service は enable 済みのためマシン起動時に自動起動し、linger は不要。linger が必要なのは tomo の user timer である backup timer（`kakeiboot-backup@<env>.timer`）で、timer発火がloginに依存しないために要る（lingerが無いとbackupが静止する）。`loginctl enable-linger tomo` 済み（確認: `loginctl show-user tomo --property=Linger` → `Linger=yes`）。
