// エミュレータ専用のルール全文（games/mathjong だけ）を firebase/emulator.rules.json に書く（試験用・本番には使わない）。
// 本番の候補は scripts/prepare-mathjong-rules.cjs（現行ルール全文に追加する）で作る。
const fs = require('node:fs');
const path = require('node:path');
const rules = { rules: { games: { mathjong: require('../firebase/mathjong-rules.cjs') } } };
fs.writeFileSync(path.join(__dirname, '../firebase/emulator.rules.json'), JSON.stringify(rules, null, 2) + '\n');
console.log('firebase/emulator.rules.json written (emulator only)');
