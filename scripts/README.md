# 過去の検証コード（legacy）

このフォルダーは **2026-10-24 までの試験に使用したプロトタイプを、変更せず保管する目的**で作成したアーカイブです。正式なゲームエンジンではありません。

## ファイル

- [trig_sim.py](legacy/trig_sim.py): 4人対戦、3枚1面子、チー・ロンの初期試作。関数牌各12枚。
- [trig_sim_v06.py](legacy/trig_sim_v06.py): 上のコードを読み込み、関数牌各12枚と16枚、追加役、表裏九角無双判定を比較。
- [trig_roles_v06.py](legacy/trig_roles_v06.py): 初期の役別完成形列挙・試験。
- [nine_angles_check.py](legacy/nine_angles_check.py): 特殊和了「九角無双」の角度収集確率を、他家の競合を無視した別モデルで試算。

過去の出力は [results/2026-10-24-function-12-vs-16.txt](../results/2026-10-24-function-12-vs-16.txt) に保管。

## ローカル実行

Python 3 系、外部依存なし。リポジトリのルートで実行:

```bash
python scripts/legacy/trig_sim.py 100
python scripts/legacy/trig_sim_v06.py --games 2500 --seed 10000
python scripts/legacy/trig_roles_v06.py 100
python scripts/legacy/nine_angles_check.py
```

上記の実行コマンドは保存元の使用法を示します。GitHub環境での全試験の再実行は**未実施**。初期スクリプトには現在の仕様と異なる役・得点の判定も含まれます。

**既知の注意点**
- 役のある和了候補の探索を一部最大30件に限定。複数の分割方法があると役を見落とす可能性。
- 最終版としてのフリテン・点棒授受・防御・複数ロンは未対応。
- 牌効率の評価関数は簡単な貪欲法で、完全探索ではない。
- 鳴き割り込み、山の消費、手番遷移は正式実装時にユニットテスト必須。
- 九角無双を狙うAIは未実装。通常AI対戦で役満0回という結果を、完成不可能と解釈しない。
- `trig_sim_v06.py` は旧版のPythonコードを動的に組み立てる方式（`exec`）であり、新規開発には流用しない方がよい。
- `trig_roles_v06.py` は旧環境の絶対パスを含むが、隣にある `trig_sim.py` を import できる環境なら利用可能。

詳細: [再現性と制約](../docs/07-simulation-reproducibility.md)。

開発再開時には `legacy/` を書き換えず、新しいバージョンのエンジンを別の場所に作り、数学の値表・面子判定・役判定・手番進行のテストから始めてください。
