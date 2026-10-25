// 1局の進行（配牌・ツモ・打牌・チー・ロン・ツモ和了・流局）を管理する状態機械。
// UI と AI はこのクラスの公開メソッドだけを使う。AI には viewFor() の公開情報だけを渡す。
import { createRng, shuffle } from './rng.js';

export const SEAT_COUNT = 4;
const next = (s, k = 1) => (s + k) % SEAT_COUNT;

export class Game {
  // players: [{ name, kind: 'human' | 'ai', personality }]
  constructor({ rules, seed = 1, dealer = 0, players, round = 1, presetWall = null }) {
    this.rules = rules;
    this.seed = seed;
    this.dealer = dealer;
    this.round = round;
    this.players = players;
    this.rng = createRng(seed);

    // 物理的な牌：id → 牌種類 index。以後、牌は id で移動し、生成・消滅しない。
    this.tileType = [];
    for (const t of rules.types) for (let c = 0; c < t.copies; c++) this.tileType.push(t.idx);
    // presetWall: テスト用。山の並び（牌種類 key の配列、末尾から引く）を指定できる。
    this.wall = presetWall ? this._wallFromPreset(presetWall) : shuffle(this.tileType.map((_, i) => i), this.rng);

    this.hands = [[], [], [], []];
    this.melds = [[], [], [], []]; // { meld, kind: 'formula'|'koutsu', call: 'chi'|'pon', tiles: [id×3], claimed: id, from: seat }
    this.rivers = [[], [], [], []]; // { id, tsumogiri }
    this.events = [];
    this.result = null;
    this.turnCount = 0;

    for (let r = 0; r < rules.config.handSize; r++) {
      for (let k = 0; k < SEAT_COUNT; k++) this.hands[next(dealer, k)].push(this.wall.pop());
    }
    this.current = dealer;
    this.phase = 'turn';
    this.claim = null;
    this._draw(dealer);
  }

  _wallFromPreset(keys) {
    const pool = new Map();
    this.tileType.forEach((t, id) => {
      const k = this.rules.types[t].key;
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(id);
    });
    const ids = keys.map((k) => {
      const list = pool.get(k);
      if (!list || !list.length) throw new Error(`preset wall: no tile ${k}`);
      return list.pop();
    });
    // 指定外の残りは山の底（先頭側）に置く
    const rest = [...pool.values()].flat();
    return [...rest, ...ids.reverse()];
  }

  typeOf(id) { return this.tileType[id]; }
  log(e) { this.events.push(e); }
  countsOf(ids) { return this.rules.countsOf(ids.map((id) => this.tileType[id])); }
  exposedMelds(seat) { return this.melds[seat].map((m) => m.meld); }
  isClosed(seat) { return this.melds[seat].length === 0; }

  _draw(seat) {
    if (!this.wall.length) return this._endDraw();
    const id = this.wall.pop();
    this.hands[seat].push(id);
    this.current = seat;
    this.phase = 'turn';
    this.drawn = id;
    this.justDrew = true;
    this.turnCount++;
    this.log({ type: 'draw', seat });
  }

  // 現在、誰の何の判断待ちか
  pending() {
    if (this.phase === 'ended') return null;
    if (this.phase === 'turn') {
      return { seat: this.current, type: 'turn', canTsumo: !!this.tsumoAnalysis(this.current) };
    }
    const c = this.claim.queue[this.claim.pos];
    const o = this._claimOptions(c);
    return { seat: c.seat, type: 'claim', tile: this.claim.tile, from: this.claim.from, ron: o.ron, chi: o.chi, pon: o.pon };
  }

  // 宣言待ちの席が「いま」選べる選択肢。より近い席がポンを選んでいれば、ポン・チーはもう成立しないので出さない
  // （ロンだけが残る）。どの席の選択も他の席には知らされない。
  _claimOptions(c) {
    const ponTaken = !!(this.claim && this.claim.ponChoice);
    return { ron: c.ron, chi: ponTaken ? [] : c.chi, pon: ponTaken ? null : c.pon };
  }

  tsumoAnalysis(seat) {
    if (this.phase !== 'turn' || seat !== this.current || !this.justDrew) return null;
    return this.rules.analyzeWin(this.countsOf(this.hands[seat]), this.exposedMelds(seat));
  }

  ronAnalysis(seat, tileId) {
    return this.rules.analyzeWin(this.countsOf([...this.hands[seat], tileId]), this.exposedMelds(seat), { ron: true });
  }

  // チーとポンの合計回数の上限（旧設定の maxChi にも対応）
  get maxCalls() {
    const r = this.rules.config.rules;
    return r.maxCalls ?? r.maxChi;
  }

  // seat が tileId（上家の打牌）でチーできる面子の候補（数式面子のみ）
  chiOptions(seat, tileId) {
    if (this.melds[seat].length >= this.maxCalls) return [];
    const t = this.tileType[tileId];
    const out = [];
    for (const mi of this.rules.meldsByTile[t]) {
      if (this.rules.melds[mi].kind !== 'formula') continue;
      const others = this.rules.melds[mi].tiles.filter((x) => x !== t);
      const use = [];
      const hand = this.hands[seat].slice();
      for (const o of others) {
        const i = hand.findIndex((id) => this.tileType[id] === o);
        if (i < 0) break;
        use.push(hand[i]);
        hand.splice(i, 1);
      }
      if (use.length === 2) out.push({ meld: mi, use });
    }
    return out;
  }

  // seat が tileId（他家の打牌）でポンできるか。できれば { meld: 刻子の index, use: [手牌の id×2] }、できなければ null。
  ponOption(seat, tileId) {
    if (!this.rules.config.rules.pon || this.melds[seat].length >= this.maxCalls) return null;
    const t = this.tileType[tileId];
    const k = this.rules.koutsuOf(t);
    if (!k) return null;
    const use = this.hands[seat].filter((id) => this.tileType[id] === t).slice(0, 2);
    return use.length === 2 ? { meld: k.idx, use } : null;
  }

  // ---- 手番の行動 ----
  discard(seat, tileId) {
    this._expect(seat, 'turn');
    const i = this.hands[seat].indexOf(tileId);
    if (i < 0) throw new Error('tile not in hand');
    this.hands[seat].splice(i, 1);
    this.rivers[seat].push({ id: tileId, tsumogiri: tileId === this.drawn });
    this.log({ type: 'discard', seat, tile: tileId });
    this.drawn = null;
    this.justDrew = false;
    this._openClaims(seat, tileId);
  }

  tsumo(seat) {
    this._expect(seat, 'turn');
    const a = this.tsumoAnalysis(seat);
    if (!a) throw new Error('tsumo not possible');
    this._endWin(seat, 'tsumo', this.drawn, null, a);
  }

  // ---- 打牌後の割り込み（優先順位：ロン ＞ ポン ＞ チー） ----
  // 打牌者から手番順に近い席から1人ずつ判断する（各席は自分の選択肢の中から1つ選ぶ）。
  // ・ロン：その場で和了（より近い席はすでにロンを見送っている＝アタマハネ）。
  // ・ポン／チー：選択を保留し、後続の席のロン判断（ポンはさらに後続のポンより優先）が終わってから確定する。
  //   → 別の人にロンの機会がある間は、ポン・チーを確定させない。
  // ・最も近い席のポンが、チーより優先される。後続の席にはポン・チーを聞かない（ロンだけ聞く）。
  _openClaims(from, tileId) {
    const queue = [];
    for (let k = 1; k < SEAT_COUNT; k++) {
      const s = next(from, k);
      const ron = !!this.ronAnalysis(s, tileId);
      const chi = k === 1 ? this.chiOptions(s, tileId) : [];
      const pon = this.ponOption(s, tileId);
      if (ron || chi.length || pon) queue.push({ seat: s, ron, chi, pon });
    }
    if (!queue.length) return this._advance(from);
    this.phase = 'claim';
    this.claim = { from, tile: tileId, queue, pos: 0, chiChoice: null, ponChoice: null };
  }

  // decision: { type: 'ron' } | { type: 'pon' } | { type: 'chi', option: index } | { type: 'pass' }
  respond(seat, decision) {
    this._expect(seat, 'claim');
    const c = this.claim.queue[this.claim.pos];
    const o = this._claimOptions(c);
    if (decision.type === 'ron') {
      if (!o.ron) throw new Error('ron not possible');
      const a = this.ronAnalysis(seat, this.claim.tile);
      return this._endWin(seat, 'ron', this.claim.tile, this.claim.from, a);
    }
    if (decision.type === 'pon') {
      if (!o.pon) throw new Error('pon not possible');
      // 後続のロン判断が終わるまで保留。最初に選ばれたポン（＝最も近い席）だけが有効。
      this.claim.ponChoice = { seat, ...o.pon };
    } else if (decision.type === 'chi') {
      const opt = o.chi[decision.option];
      if (!opt) throw new Error('invalid chi option');
      // ロン・ポン優先のため、後続の判断が終わるまでチーは保留
      this.claim.chiChoice = { seat, ...opt };
    } else if (decision.type !== 'pass') {
      throw new Error('unknown decision');
    }
    this.claim.pos++;
    while (this.claim.pos < this.claim.queue.length) {
      const q = this._claimOptions(this.claim.queue[this.claim.pos]);
      if (q.ron || q.pon) return; // 次の人のロン（またはまだ有効なポン）の判断を待つ
      this.claim.pos++; // ロンもポンもない人（チーは下家＝先頭だけ）は飛ばす
    }
    const { from, tile, chiChoice, ponChoice } = this.claim;
    this.claim = null;
    if (ponChoice) return this._doCall('pon', ponChoice, from, tile);
    if (chiChoice) return this._doCall('chi', chiChoice, from, tile);
    this._advance(from);
  }

  // チー・ポンの確定：打牌を河から公開面子へ移し、手牌2枚を公開する。鳴いた人の打牌番になる（間の席は飛ばす）。
  _doCall(call, choice, from, tileId) {
    const { seat, meld, use } = choice;
    const river = this.rivers[from];
    const ri = river.findIndex((r) => r.id === tileId);
    if (ri < 0) throw new Error('claimed tile is not in the river');
    river.splice(ri, 1);
    for (const id of use) {
      const i = this.hands[seat].indexOf(id);
      if (i < 0) throw new Error('call tile is not in the hand');
      this.hands[seat].splice(i, 1);
    }
    const kind = this.rules.melds[meld].kind;
    this.melds[seat].push({ meld, kind, call, tiles: [...use, tileId], claimed: tileId, from });
    this.log({ type: call, seat, from, tile: tileId, meld });
    this.current = seat;
    this.phase = 'turn';
    this.drawn = null;
    this.justDrew = false; // 鳴いた直後はツモ和了不可。打牌のみ。
  }

  _advance(from) {
    if (!this.wall.length) return this._endDraw();
    this._draw(next(from));
  }

  _endWin(seat, how, tileId, from, analysis) {
    if (how === 'ron') {
      const river = this.rivers[from];
      river.splice(river.findIndex((r) => r.id === tileId), 1);
      this.hands[seat].push(tileId);
    }
    this.phase = 'ended';
    this.claim = null;
    this.result = { type: 'win', winner: seat, how, from, tile: tileId, analysis, points: analysis.points };
    this.log({ type: 'win', seat, how, from });
  }

  _endDraw() {
    this.phase = 'ended';
    this.claim = null;
    this.result = { type: 'draw' };
    this.log({ type: 'exhaustive-draw' });
  }

  _expect(seat, phase) {
    const p = this.pending();
    if (!p || p.type !== phase || p.seat !== seat) throw new Error(`not ${seat}'s ${phase}`);
  }

  // ---- AI に渡す公開情報（自分の手牌＋全員の公開情報のみ。他家の手牌・山の並びは含めない） ----
  viewFor(seat) {
    return {
      seat,
      hand: this.hands[seat].map((id) => ({ id, type: this.tileType[id] })),
      drawn: this.current === seat ? this.drawn : null,
      melds: this.melds.map((ms) => ms.map((m) => ({ meld: m.meld, kind: m.kind, call: m.call, tiles: m.tiles.map((id) => this.tileType[id]), from: m.from }))),
      rivers: this.rivers.map((r) => r.map((x) => this.tileType[x.id])),
      handCounts: this.hands.map((h) => h.length),
      wallCount: this.wall.length,
      dealer: this.dealer,
    };
  }

  // ---- 不変条件：全ての牌がちょうど1か所に存在し、手牌枚数が正しい ----
  checkInvariants() {
    const seen = new Array(this.tileType.length).fill(0);
    const mark = (id) => { seen[id]++; };
    this.wall.forEach(mark);
    this.hands.forEach((h) => h.forEach(mark));
    this.rivers.forEach((r) => r.forEach((x) => mark(x.id)));
    this.melds.forEach((ms) => ms.forEach((m) => m.tiles.forEach(mark)));
    const bad = seen.findIndex((n) => n !== 1);
    if (bad >= 0) throw new Error(`tile ${bad} appears ${seen[bad]} times`);
    for (let s = 0; s < SEAT_COUNT; s++) {
      const expectBase = this.rules.config.handSize - 3 * this.melds[s].length;
      const n = this.hands[s].length;
      const holding = this.phase === 'turn' && this.current === s;
      const won = this.result && this.result.type === 'win' && this.result.winner === s;
      const ok = holding || won ? n === expectBase + 1 : n === expectBase;
      if (!ok) throw new Error(`seat ${s} has ${n} tiles (melds ${this.melds[s].length}, phase ${this.phase})`);
      for (const m of this.melds[s]) {
        const ts = m.tiles.map((id) => this.tileType[id]);
        if (this.rules.meldOf(...ts)?.idx !== m.meld) throw new Error('invalid exposed meld');
      }
    }
    return true;
  }
}
