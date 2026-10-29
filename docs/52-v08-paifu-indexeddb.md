# Ver.0.8 第2段階：独立IndexedDB保存アダプター

2026-10-29。PR #37 `feature/v08-paifu-foundation`、第1段階HEAD `3f1344fe133593a823e9c9416c3868df6a716e59` からの追加実装。[牌譜スキーマ](51-v08-paifu-foundation-schema.md)の内容・既存エンジン・UI・localStorage・再現URLを変更しない。PR #36には触れない。**Draftのまま、mainマージ・Pages公開は禁止。通常対局の自動記録/自動保存には接続しない。**

## 開始条件の確認

PR #37のGitHub HEADは3f1344f、状態はDraft。専用CI [40860681346](https://github.com/asumax1128/mathjong/actions/runs/40860681346) が同HEAD・同ブランチで**Success（5分41秒）**となったことを確認してから実装した。この結果を追加実装後のHEADのCI成功として流用しない。

## 保存先とデータ構造

`src/ui/paifu-storage.js`の`createPaifuStore()`が作る、呼出時だけ動作する独立アダプター。importやfactory生成ではDBを開かない。app.jsから未import。localStorage・ネットワーク・AI・Game・DOMへアクセスしない。

- IndexedDB名：`mathjong-paifu`
- DB version：1
- 保存行のstorageVersion：1
- 牌譜本文のschemaVersion：既存の1（独立した別の版）

| object store | keyPath | データ |
|---|---|---|
| `records` | `id` | storageVersion, id, token, revision, bytes, digest, json |
| `index` | `id` | storageVersion, id, token, revision, bytes, digest, savedAt, schemaVersion, visibility, mode, length, status, rounds |

`json`は既存`encodePaifu`による検証済みの正規JSON。`bytes`はUTF-8本文サイズ、`digest`はSHA-256。索引に手牌・山順・本文を複製しない。本文と索引は**同じreadwrite transaction**で更新・削除する。request成功だけで保存成功にせず、transactionの`complete`を待つ。

保存前に検証・JSON確定・ハッシュを行い、その後transactionを開く。transactionの中でawait・ネットワーク・全牌譜の再生検証をしない。呼出元が非同期処理の途中でオブジェクトを書き換えても、保存するJSONとmetadataは変わらない。

## API

```js
const store = createPaifuStore();
const saved = await store.save(record);          // 新規IDのみ
const loaded = await store.loadPrivate(record.id); // 本文+SHA+スキーマ+全状態を検証
const checked = await store.verify(record.id);  // 同じ検証、本文は返さない
const listed = await store.list();              // 索引のみ。本文の完全性を保証するAPIではない
const changed = await store.save(nextRecord, {
  expectedToken: loaded.metadata.token,          // 明示的な置換
});
const removed = await store.remove(record.id);  // 指定IDを明示削除
const guarded = await store.remove(record.id, { expectedToken: loaded.metadata.token });
const cleared = await store.clearAll();         // 専用DBの2ストアだけを原子的にclear
```

実際には各戻り値の`ok`を確認してから値を利用する。

- 成功：`{ok:true, ...}`。保存/読込/検証はmetadata、一覧はentries/bytes、削除はremoved、一括削除はclearedを返す。
- 失敗：`{ok:false,error:{code,retryable}}`。public操作は例外throw・Promise rejectではなく結果を返す。エラーに牌譜本文・手牌・例外の全文を含めず、勝手にconsoleやサーバーへ送らない。
- `save`の同一ID更新は読込/直前保存のtokenが必要。revisionは1から増加し、tokenは毎回新しい128bit暗号乱数。ゲーム用Math.random/seed付きRNGは使わない。削除/再作成でrevisionが1へ戻っても旧tokenは使えない（ABA防止）。
- 保存時の新しい本文は完全検証する。既存本文の全再検証はtransaction内ではしない。置換はCASによる明示操作であり、終了済み牌譜を自動変更する機能はない。
- 読込は本文/索引の対応、bytes、SHA、ID、metadata、スキーマ、全局面を検証。破損・未知版を自動修復/削除しない。
- 個別削除はtokenなしなら破損/未知保存行も指定IDで消せる。一括削除も明示操作だけ。他DB・localStorageを削除しない。未知のDB版や不正なDB構造は削除/降格しない。

## 容量と競合

現段階のfactory既定値：**20件・本文合計32MiB・各非同期待機5秒**。引数で上限を指定できるが、実UIの正式な保持方針や設定画面は未実装。

- 1本文は既存コードクの8MiB上限。
- 32MiBは検証済みJSONの論理サイズ合計であり、DBの索引・ブラウザ内部オーバーヘッド・他データを含む物理ディスク容量ではない。空き容量の予約でもない。
- 件数/合計上限は索引を同一write transaction内で集計。置換では旧本文サイズを差し引く。別インスタンスの同時保存もnative transactionで直列化し、上限超過や古いtokenの更新を拒否。
- 容量超過時に古い牌譜を自動削除しない。小さい上限を指定しても、既存データを切り捨てない。
- `clearAll`はそのtransaction時点の全件を削除する。その後の新規保存を永久に禁止するものではない。旧tokenの保存は拒否する。将来の自動保存では書込キューとの調停が必要。

## 異常系とゲームからの隔離

代表的なcode：`unavailable`, `blocked`, `timeout`, `interrupted`, `quota-exceeded`, `capacity-exceeded`, `record-too-large`, `conflict`, `not-found`, `invalid-record`, `invalid-argument`, `corrupt`, `unsupported-version`, `storage-error`, `outcome-unknown`。

- IndexedDB getter/openがSecurityError、利用不可、非同期エラーでも結果として失敗を返す。localStorageへの代替保存はしない。
- 書込エラーはtransactionをabortし、本文/索引の部分保存を防ぐ。削除・clearの中断も同様。
- タイムアウトでまだabort可能なら中断。**commit境界でabort不能なら`outcome-unknown`**を返す。未保存やロールバック成功と断定せず、再読込で状態確認する。盲目的な再保存はしない。
- IDBのopen request自体は取消APIがない。遅れて成功した接続は閉じ、期限後のupgradeはabortする。呼出側が短い間隔で無制限に再試行する設計にはしない。
- 操作ごとに接続を閉じる。versionchange・異常closeは進行中の操作を終了し、接続を解放。将来のDB版を勝手に書き換えない。
- `durability:'strict'`を要求し、旧APIのTypeErrorなら通常のtransactionへフォールバックする。OS/ブラウザによる消去や端末障害まで永続保証するものではない。
- `list`は索引検査であり、本文のSHA/内容は`loadPrivate`/`verify`で確認する。索引が壊れて一覧に失敗した場合でも既知IDの個別読込/削除は可能。不正なDB構造・将来DB版の救済/移行は別設計で、自動resetしない。

今回、ゲームからの呼出しはない。将来の接続時も、保存失敗で既に成立した打牌や精算を巻き戻さず、保存通知/再試行とゲーム進行を分離する。テストでは保存利用不可でも実Gameが進行し、非保存Gameと状態・次のRNGが一致することを確認する。

## private-fullと必要なブラウザ機能

完全牌譜は私有データ。IndexedDBは同一originのJSから読める保存先であり、暗号化/公開権限管理ではない。SHA-256も改ざん者の本人性を保証する署名ではない。`loadPrivate`だけが本文を返し、list/verifyは管理metadataだけ。AIや公開共有へ渡す接続、upload、共有URLは追加しない。

保存・本文検証にはWebCryptoのSHA-256が必要。https/localhostのsecure contextを前提とし、利用不可なら失敗を返す。Safari実機やプライベートブラウズでの可用性/保持期間は別途確認する。テストのSecurityErrorや旧API故障注入をSafari実機合格とは呼ばない。

## テストと性能

| 検査 | 結果 |
|---|---|
| 全単体 | **426件成功（第1段階409＋新規17）、失敗・スキップ0** |
| 保存専用ブラウザ | **実IndexedDBの21項目成功**。reload・CAS/ABA・容量競合・abort/timeout・削除中断・タブ終了・将来DB版・破損・SHA検査・接続解放を含む |
| 第1段階の牌譜ブラウザ | 数学Ⅰ/Ⅱ×320/390pxの4条件成功 |
| 既存の関連E2E | `v06TrioIntegration,v07BeginnerRoom2,v05Riichi,v04End`成功。数学ⅠⅡ×4/8局のAI・初心者4〜6・リーチ・終了条件を確認 |
| 構文・差分・workflow YAML・文書リンク | 成功 |

全体の`play.mjs`は今回再実行していない。第1段階の902.804秒の成功はそのHEADの履歴であり、第2段階の全体成功とは呼ばない。既存426件の対象・関連ブラウザ検査をスキップせず実行した。

検証ブラウザはシステムChromium 154.0.8037.57（起動ヘルパー使用）。複数のChromium実行方式・WebKit・iPhone Safariを検証したという意味ではない。実装者自身の確認で、別担当者の独立監査ではない。

開発中の「native abort済みをoutcome-unknownと誤分類する」失敗は、AbortErrorとcommit境界の区別・終了済み処理への再入抑止で修正し、元の期待値を維持して再検証成功。テスト条件の弱体化・例外の握りつぶしはしない。

### 小標本の実ブラウザ実測

| fixture | UTF-8本文bytes | 保存（検証/ハッシュ/DB込み） | 読込（ハッシュ/全再検証込み） |
|---|---:|---:|---:|
| 数学Ⅰ・4局 | 1,098,423 | 約208ms | 約163ms |
| 数学Ⅱ・8局 | 4,284,847 | 約698ms | 約564ms |

fixtureは実Gameの合法なツモ切り/見送りで流局まで進めた試合。実際の人間の牌譜ではない。31回の保存→読込→削除、計93接続で終了後の残留接続0を確認。実ヒープ/GC量や長期のメモリ増加は測定していない。QuotaExceededErrorは故障注入であり、実端末の空き容量を枯渇させた試験ではない。

詳細：[validation/v08-paifu-storage.json](validation/v08-paifu-storage.json)。新HEADのCI結果はpush後のPR #37で確認し、開始HEADのSuccessを流用しない。

Nodeの異常系テストはopen失敗等のイベントを注入し、通常CRUD/競合/ロールバックは**Chromiumの本物のIndexedDB**で検査する。fake-indexeddb等の依存は追加しない。

保存/読込は非同期DB APIだが、現在のコードクの全再生検証とJSON処理はメインスレッド上で同期実行する。数MBの牌譜で数百msかかるため、**通常対局中の自動保存へ接続する前にはWorker化・書込頻度・キュー/バックプレッシャ・分割保存を検討する必要がある**。現時点で操作フレームの無停止を保証しない。公開サイトのゲームには未接続である。

## 未実装・次の判断

1. Safari実機の可用性・容量・プライベートブラウズ・タブ終了の受入。
2. Worker等への重い検証処理の移動、長い連荘/8MiB超の分割、保持件数・保存頻度。
3. 未知版のmigration、壊れたDB/索引の部分救済、保存失敗のユーザー通知。
4. 通常対局への記録/保存の自動接続（今回は禁止）。
5. 公開用projection・共有・振り返り/戦績画面（今回の対象外）。

PR #37をDraftで維持し、専用CIを追加実装後のHEADで確認する。main・Pages・PR #36には変更しない。
