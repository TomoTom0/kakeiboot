# stg・prod 運用環境（kakeiboot）

作業repo（`/home/tomo/work/app/tool/budget-book`）での実行は dev（`mise run dev:backend`・`dev:frontend`・test・browser撮影等）まで。stg・prodの実行は運用dir上の systemd user service で行い、deployは作業repoでbuildした成果物をrsyncで配布する（運用dirはgit repoではない）。

## 構成

| 項目 | stg | prod |
|---|---|---|
| 運用dir | `/srv/opt/tomo/run/app/tool/kakeiboot/stg` | `/srv/opt/tomo/run/app/tool/kakeiboot/prod` |
| config | `configs/stg` | `configs/prod` |
| listen port | 40282 | 40283 |
| systemd unit | `kakeiboot-stg.service` | `kakeiboot-prod.service`（作成済み・disabled） |
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
- unit file: `~/.config/systemd/user/kakeiboot-{stg,prod}.service`。`WorkingDirectory` = 運用dir、`ExecStart` = `<運用dir>/budget-book --config-dir configs/<env>`（miseタスク `stg:backend` と同じ指定）、`Restart=on-failure`
- `Environment=` の設定は不要（port・path等は configs/<env>/*.toml が正本。`RUST_LOG` を設定すれば `[log] filter` を上書きできる）

## deploy手順（stg）

作業repoの dev にコミット済みの状態から:

```sh
cd /home/tomo/work/app/tool/budget-book
mise run build
env=stg
rsync -a target/debug/budget-book /srv/opt/tomo/run/app/tool/kakeiboot/$env/budget-book
rsync -a --delete configs/$env/ /srv/opt/tomo/run/app/tool/kakeiboot/$env/configs/$env/
rsync -a --delete frontend/dist/ /srv/opt/tomo/run/app/tool/kakeiboot/$env/frontend/dist/
systemctl --user restart kakeiboot-stg
systemctl --user status kakeiboot-stg
curl -fsS http://localhost:40282/healthz
```

rsyncの対象と除外:

- 対象: backend binary（単file。`-a` で上書き）・`configs/<env>/`（`--delete` で完全同期）・`frontend/dist/`（`--delete` で旧hash付きassetを掃除）
- 除外: `var/`（runtimeデータ。`--delete` を運用dir全体に向けない）
- rsyncは途中階層を作らないため、初回は `configs/`・`frontend/` の親dirを先に作成する

prodへの配備も同一手順（`env=prod`・`systemctl --user restart kakeiboot-prod`）。現状は体制のみ配備済みで起動していない。

## prodの開始条件

main branchの運用を開始するまで prod は起動しない（unitは登録済み・disabled）。開始時は:

1. 作業repoで main branchの運用を開始する
2. 上記deploy手順で main の成果物を prod 運用dirへ配備する
3. `systemctl --user enable --now kakeiboot-prod`

## マシン起動時の自動起動（linger）

user service をマシン起動時（ログイン前）に起動するには linger が必要。`loginctl enable-linger tomo` 済み（確認: `loginctl show-user tomo --property=Linger` → `Linger=yes`）。
