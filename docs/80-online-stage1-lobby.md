# 数雀｜オンライン対戦 段階1「ロビーまで」実装メモ

設計の正本は [docs/79](79-online-play-design.md)。未決事項 U1〜U11 は、設計書の推奨どおりに決定済みとして実装した。
この段階では、対局の進行・RemoteTable・宣言ウィンドウは作らない（段階2）。本番 Firebase への接続とルールの適用もしない（段階4）。

## 1. 入口と、本番に接続しないための仕組み

- タイトルの「オンライン対戦」は、**ローカル開発環境の `?online=emu` のときだけ**表示する。
  - 接続先は Auth・Database エミュレータで、プロジェクトは `demo-mathjong`。
  - 公開サイト（localhost 以外のホスト）では、この引数を無視する。E2E で確認済み。
- `src/ui/online-config.js` の `ONLINE_PUBLIC = false`。
  - 画面側でも、エミュレータでなければ接続せず「お休み中」と表示する。
  - 段階4で、ルールを適用した後にこの値を切り替える。
- `FB_CONFIG` は FACTOR×FACTOR と同じ公開値（asumath-games）を転記した。段階1では使わない。
- `?onlineAppVersion=` はローカル開発環境だけで使える試験用の引数で、版の違いを確かめるために使う。

## 2. 構成

| ファイル | 役割 |
|---|---|
| `src/ui/online-config.js` | 定数（FB_CONFIG・部屋コードの文字種・期限 12 時間・ルールセット 2）。純関数として、コードの生成（crypto・偏りなし）、コードの整形、ニックネームの検査 |
| `src/ui/online-transport.js` | Transport の窓口。2つの実装を持つ（下記）。 |
| `src/ui/online-lobby.js` | ロビーの論理。作成・参加・設定・開始・presence・退出・監視。Transport だけを使う |
| `src/ui/online-ui.js` | 画面。app.js が動的 import する。app.js の状態 S には触れない |
| `src/ui/app.js` | 変更は最小限：入口のボタン、画面 `online` の描画、操作の受け渡し |
| `src/ui/styles.css` | オンライン画面のスタイル（追記のみ） |

`online-transport.js` の2つの実装：

- `createMemoryBus()`：メモリ上の偽バス。単体試験に使う。
- `createFirebaseTransport()`：modular SDK 12.12.0 を gstatic から動的 import する。

読込の流れと、失敗したときの扱い：

1. Firebase SDK は、オンラインの画面に入ったときにだけ読み込む。タイトルを開いただけでは読み込まない（E2E で確認済み）。
2. SDK の読込に失敗した場合は、「読み込めませんでした」と表示してタイトルへ戻れる。通常対局・初心者の部屋・牌譜はそのまま動く（E2E で確認済み）。
3. 匿名認証のアプリ名は固定している。uid が端末に保存されるので、同じ端末から入り直すと自分の席に戻れる（docs/79「8.2」）。

## 3. 部屋とルール（`firebase/mathjong-rules.cjs`）

データの形は docs/79「6」の段階1部分です。段階2・3で次を追加する：

- `status` の `result`、`final`、`paused`
- 席の `kind: 'cpu'`、`cpuId`、`away`

| ノード | 段階1の中身 | 書く人 | 読む人 |
|---|---|---|---|
| `config` | `{ enabled }`（停止スイッチ） | Console だけ | 認証済み |
| `rooms/$code/meta` | `hostUid, status(lobby/playing/closed), mode, length(1/4/8), ruleset(2), appVersion, createdAt, expiresAt(≤createdAt+12h), startedAt, matchNo` | 作成者が作り、以後はホストだけが書く。ホストの付け替え、期限の延長、作成時刻の変更はできない | 認証済み |
| `rooms/$code/seats/$seat` | `{ uid, name(1〜10), kind:'human', joinedAt }` | 空席は本人が取る（ロビー中で、まだ席が無いときだけ）。本人は名前を更新でき、ロビー中なら離席できる。ホストはすべて書ける | 認証済み |
| `rooms/$code/presence/$uid` | `{ online, at }` | 本人（期限内だけ） | 認証済み |
| `pub` / `priv/$seat` / `act/$seat/$n` / `host` | 段階2で使う。権限だけを先に確定した | ホスト／ホスト／本人の追記／ホスト | 参加者／本人／ホストと本人／ホスト |

docs/79「5.3」の案から変えた点（ルール試験で確定）：

- **ホストは自分の部屋を丸ごと削除できる**ようにした。退出で部屋を閉じるため。
  - 期限切れの部屋は、これまでどおり誰でも丸ごと削除だけできる。
- **作成時の検査を足した**：`status === 'lobby'`、`createdAt` は `now ± 5 分`、`expiresAt ≤ createdAt + 12 時間`。
  - 変更のときは、`createdAt`・`expiresAt`・`hostUid` を変えられない。
- **席を2つ取れない**ようにした（`!isMember`）。
- 席と presence に**期限内の条件**を付けた。
- **未知の子を拒否する**ようにした：`$other: { .validate: false }`。

## 4. ルール候補の作り方（所有者の作業・段階4）

1. Firebase Console から現行ルールの全文を JSON で書き出す。リポジトリの外に置く。
2. 次のコマンドを実行する：`node scripts/prepare-mathjong-rules.cjs <現行ルール全文.json> <出力先ディレクトリ>`
   - `games/mathjong` だけを追加し、それ以外が1文字も変わらないことを `deepEqual` で確かめる。
   - 次の場合は止まる：すでに `games/mathjong` がある、`rules`・`games` に広い権限がある、想定と違う形になっている。
   - 出力は `mathjong-candidate.rules.json`（権限 0600）。本番には接続しない。
3. 候補を確認し、Console に貼り付けて適用する。適用は段階4で行う。

**現行ルールの書き出しはまだ手元に無い**ため、候補の生成そのものは実施していない。スクリプトの動作は、見本の全文で単体試験済み（`tests/online-rules-prepare.test.js`）。

## 5. 試験

| 層 | ファイル | 中身 |
|---|---|---|
| ① 単体（ネットワークなし） | `tests/online-lobby.test.js` | 偽バスで、ホスト1人とゲスト3人を動かす。対象：コードの生成と衝突、名前、作成、参加、誤ったコード、満席、版の違い、期限切れ、開始後、設定と開始の権限、監視、presence、退出 |
| ① 単体 | `tests/online-rules-prepare.test.js` | 候補作成スクリプト：他の枝が変わらないこと（deepEqual）、止まる条件、CLI、0600 |
| ② ルール試験（エミュレータ） | `tests/online-rules-emulator.mjs` | REST で 83 件。他家の priv が読めない、pub/host に書けない、他席の act に書けない、ロビー以外で席を取れない、期限切れは丸ごと削除だけできる、ほか |
| ②' 結合（エミュレータ） | `tests/online-lobby-emulator.mjs` | 実際の SDK（npm の firebase@12.12.0）、ロビーの論理、ルールを組み合わせて 15 件。transaction によるコードの衝突回避、切断時の presence を含む |
| ③ 複数コンテキストの E2E | `tests/e2e/online-lobby.mjs` | ブラウザの別コンテキストを 2〜5 個使い、17 件。gstatic への要求は npm の同じ版で応答する（下記） |

③ で確かめる項目：

- 作成・参加・名前の表示・設定の共有
- 開始ボタン（1人では押せない、ゲストには無い）
- 退出・誤ったコード・満席・版の違い
- 切断・入り直し・開始・ホストの退出
- 停止スイッチ
- SDK の読込に失敗してもオフラインの機能が動くこと
- 公開ホストでは入口が出ないこと

手元で実行する手順：

```sh
npm install --no-save --no-package-lock playwright@1.56.1 firebase@12.12.0
npm install --prefix /tmp/firebase-cli firebase-tools@14.27.0   # Java 21 が必要
node scripts/build-emulator-rules.cjs
/tmp/firebase-cli/node_modules/.bin/firebase emulators:exec --only auth,database --project demo-mathjong --config firebase.emulator.json \
  "node tests/online-rules-emulator.mjs && node tests/online-lobby-emulator.mjs && node tests/e2e/online-lobby.mjs"
```

画面を手で試すときの手順：

1. エミュレータを起動する：`firebase emulators:start --only auth,database --project demo-mathjong --config firebase.emulator.json`
2. 停止スイッチを有効にする：`curl -X PUT -H 'Authorization: Bearer owner' 'http://127.0.0.1:9000/games/mathjong/config.json?ns=demo-mathjong-default-rtdb' -d '{"enabled":true}'`
3. `npm start` を実行し、`http://localhost:8080/?online=emu` を開く。
   - 2人目は、別のブラウザかシークレットウィンドウで開く。

CI は `.github/workflows/online-lobby.yml`（ubuntu-24.04）。ジョブは2つ：

- `unit`：`npm test` の全件
- `emulator`：Java 21、firebase-tools@14.27.0（`RUNNER_TEMP` に入れる）、②・②'・③

## 6. 段階2へ持ち越すこと

- 対局の進行：RemoteTable、`pub/priv/act` の中身、宣言ウィンドウ、時間切れ、代打ち
- 席の `kind:'cpu'`（ホストが CPU を選ぶ、U7）、席と親の無作為な決定（U9）
- ホストの切断から 90 秒で試合を終える処理（U3）、離席の判定（10 秒）
- BroadcastChannel による端末内の簡易経路（docs/79「9.0④」）
