# 数雀「初心者の部屋」実装第1弾：ステージ1〜3

> 状態：第1〜3段階を2026-10-28にmainへマージ済み。オーナーによるiPhone Safari実機確認は未実施。
> PR #20：https://github.com/asumax1128/mathjong/pull/20
> マージコミット：b9cd0bee078fd823529d7b19e905aab07cb5006a
> 初期設計案：PR #19（docs/33-beginner-hall-proposal.md）
> この版は第1〜3段階の体験学習だけを実装し、第4〜6段階の実装・公開はまだ行わない。

## 仕様
- タイトルに「初心者の部屋（練習）」を設け、数学Ⅰで3段階の練習ができる。
- 1. 関数牌・角度牌・結果牌をタップして3枚で数式面子を作る。
- 2. 9枚を3枚ずつの面子に分ける。sin30°=1/2、cos60°=1/2、tan45°=1 が成立する。
- 3. 8枚にツモ1枚が加わった9枚から、不要な=-1牌を選んで捨てる。次の=1牌を引けば3面子の和了になることを示す。
- 正誤は既存エンジンの meldOf と analyzeWin だけで判定し、数学ルールを複製しない。
- 毎段階でヒント・誤答からの再挑戦に対応。各段階を順にクリアし、タイトルに帰還できる。
- 状態は一時メモリのみ。通常対局の設定、キャラ選択、AIの性格・得点・山・牌配置を変更しない。
- データ保存・アカウント・ログインは不要。
- 第4〜6段階（鳴き・リーチ／ロン／ツモ・ガイド付き1局）は次の開発対象であり未実装。

## 自動テストと実機
- tests/beginner-room.test.js で実際の数学Ⅰ牌、ステージごとの正誤、9枚の和了、選択上限を検証。
- tests/e2e/play.mjs に v07BeginnerRoom を追加：320/390/430px、ボタンタップ、誤答・正答、ステージ移動、通常対局へ戻れることを検証。
- 実行方法：npm test、node tests/e2e/play.mjs --only v07BeginnerRoom、node tests/e2e/play.mjs --only v06FreeSelect,v07BeginnerRoom。
- 実行/成功が確認できていないテストについて、合格と記録しない。
- オーナーが既存GitHub Pagesの同じURLでiPhone Safari実機テストする。新サイトは作らない。
- CI（Beginner room 1-3 checks） https://github.com/asumax1128/mathjong/actions/runs/40655422458 **成功**：構文・npm test・初心者の部屋のブラウザ操作・既存Ver.0.6自由選択の回帰を確認。
- Character AI experiment（PR #20） https://github.com/asumax1128/mathjong/actions/runs/40655422411 はマージ判定時点では実行中。未完了を合格とは記録しない。
- PR #20をmainにマージ済み。既存Pagesへの反映とiPhone Safari実機操作は別に確認する。
