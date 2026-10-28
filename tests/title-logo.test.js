// タイトル画像（Ver.0.5-C）：正式採用画像（オーナー採用、1536×1024、3:2、背景透過 PNG）と、表示幅に合わせた縮小版の構造
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const UI = new URL('../src/ui/', import.meta.url);
// 正式採用画像の SHA-256（オーナーが提示したハッシュ）
const OFFICIAL_SHA = 'aee4ed6781d44eef9f1a666a56ac04e27c16790a376cf770a112f48434a7ca1f';
const LADDER = [384, 576, 768, 960, 1152, 1536];
const png = (name) => readFileSync(new URL(name, UI));
const ihdr = (b) => ({ sig: b.subarray(0, 8).toString('hex'), w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], colorType: b[25], interlace: b[28] });

test('元画像（title-logo-1536.png）は正式採用画像とバイト単位で同一（SHA-256）、1536×1024・3:2・8bit RGBA', () => {
  const b = png('title-logo-1536.png');
  assert.equal(createHash('sha256').update(b).digest('hex'), OFFICIAL_SHA);
  assert.equal(b.length, 2686387);
  const h = ihdr(b);
  assert.equal(h.sig, '89504e470d0a1a0a');
  assert.deepEqual([h.w, h.h, h.depth, h.colorType], [1536, 1024, 8, 6]);
  assert.equal(h.w * 2, h.h * 3, '3:2');
});

test('縮小版はすべて 3:2 の 8bit RGBA PNG（透過あり）で、幅は srcset の記述と一致する', () => {
  for (const w of LADDER) {
    const h = ihdr(png(`title-logo-${w}.png`));
    assert.deepEqual([h.sig, h.w, h.h, h.depth, h.colorType], ['89504e470d0a1a0a', w, (w * 2) / 3, 8, 6], `title-logo-${w}.png`);
  }
});

test('index の描画（app.js）の srcset は用意した6つの幅だけを参照し、sizes は CSS の表示幅の式と同じ。width・height は元画像の大きさ', () => {
  const app = readFileSync(new URL('app.js', UI), 'utf8');
  const css = readFileSync(new URL('styles.css', UI), 'utf8');
  const tag = app.match(/<img class="title-logo-img"[^>]*>/)[0];
  const srcset = [...tag.matchAll(/src\/ui\/title-logo-(\d+)\.png (\d+)w/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(srcset.map((x) => x[0]), LADDER);
  for (const [file, desc] of srcset) assert.equal(file, desc, '幅の記述と実際のファイル名が一致');
  assert.match(tag, /width="1536" height="1024"/);
  assert.match(tag, /alt="数雀（MATHJONG）"/);
  // sizes と CSS の表示幅：通常は 45vh、低い横画面は 66vh、どちらも 380px・画面の幅−32px の最小値
  assert.match(tag, /sizes="\(orientation: landscape\) and \(max-height: 500px\) min\(calc\(100vw - 32px\), 380px, 66vh\), min\(calc\(100vw - 32px\), 380px, 45vh\)"/);
  assert.match(css, /\.title-logo-img \{[^}]*width: min\(100%, 380px, 45vh\)/);
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 500px\) \{ \.title-logo-img \{ width: min\(100%, 380px, 66vh\)/);
  // 旧画像（1448×1086 の別の画像）は、ファイルも参照も残っていない
  for (const old of ['title-logo-1448.png', 'title-logo-1084.png', 'title-logo-724.png']) {
    assert.equal(existsSync(new URL(old, UI)), false, `${old} は削除済み`);
    assert.ok(!app.includes(old) && !css.includes(old));
  }
});

test('src/ui のロゴ画像は、採用画像と縮小版の6つだけ', () => {
  const files = readdirSync(UI).filter((f) => /^title-logo-.*\.png$/.test(f)).sort();
  assert.deepEqual(files, LADDER.map((w) => `title-logo-${w}.png`).sort());
});
