// 1局の進行（配牌・ツモ・打牌・チー・ロン・ツモ和了・流局）を管理する状態機械。
// UI と AI はこのクラスの公開メソッドだけを使う。AI には viewFor() の公開情報だけを渡す。
import { createRng, shuffle } from './rng.js';
import { createDeadWall } from './dead-wall.js';

export const SEAT_COUNT = 4;
const next = (s, k = 1) => (s + k) % SEAT_COUNT;

export class Game {
  // players: [{ name, kind: 'human' | 'ai', personality }]
  // ルールの版（ruleset）：0＝従来ルール、1＝新ルール初版（PR #44：王牌・ドラ・暗カン・数学Ⅱ24回）、
  // 2＝現行の新ルール（1 に加えてフリテン・関数牌のポン禁止）。newRules: true は ruleset 1（従来の呼び出し・再現 URL newrules=1）。
  // 過去の局（従来・初版）を同じ seed で同じ進行に再現できるよう、版ごとに規則を切り替える。
  constructor({ rules, seed = 1, dealer = 0, players, round = 1, presetWall = null, newRules = false, ruleset = newRules ? 1 : 0 }) {
    this.rules = rules;
    this.ruleset = ruleset;
    this.newRules = ruleset >= 1;
    // ruleset 2：フリテン（捨て牌・同巡（見逃し）・リーチ後の見逃し）と関数牌のポン禁止
    this.furitenRule = ruleset >= 2;
    this.funcPonBan = ruleset >= 2;
    // ruleset 2：四家立直（4人全員のリーチが成立したら途中流局）。4人目の宣言牌へのロンの判断が終わってから判定する
    this.fourRiichiRule = ruleset >= 2;
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
    // リーチ（規則 rules.riichi のときだけ）：席ごとに null または { tile: 宣言牌の id, turn: 宣言時の turnCount }
    this.riichi = [null, null, null, null];
    this._riichiMemo = null;
    // ruleset 2：リーチ確定時の待ち（その席だけの非公開情報。riichi[] は他家の AI にも渡るので別に持つ）
    this.riichiWaits = [null, null, null, null];
    // ruleset 2：フリテン。discarded：その局に捨てた牌の種類（鳴かれて河から移った牌も含む）。
    // temporary：ロンできる牌を見送った（自分の次の通常ツモで解除）。riichiMissed：リーチ後に見送った（局の終わりまで）
    this.discarded = [new Set(), new Set(), new Set(), new Set()];
    this.tempFuriten = [false, false, false, false];
    this.riichiFuriten = [false, false, false, false];
    this.ronBlocked = [null, null, null, null]; // 直近にフリテンでロンできなかった牌（画面の説明用）

    for (let r = 0; r < rules.config.handSize; r++) {
      for (let k = 0; k < SEAT_COUNT; k++) this.hands[next(dealer, k)].push(this.wall.pop());
    }
    this.current = dealer;
    this.phase = 'turn';
    this.claim = null;
    this.normalDraws = [0, 0, 0, 0];
    this._draw(dealer);
    this.deadWall = this.newRules ? createDeadWall(this.wall, this.tileType, this.rules.types) : null;
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
  isClosed(seat) { return this.melds[seat].every(m=>m.call==='ankan'); }
  get doraIndicators() { return this.deadWall ? this.deadWall.indicators.map(x=>({...x})) : []; }
  ankanOptions(seat) {
    if (!this.newRules || this.phase!=='turn' || this.current!==seat || !this.justDrew || this.riichi[seat] || !this.deadWall.rinshan.length || !this.wall.length || this.deadWall.indicators.length>=5 || this.melds[seat].length>=3) return [];
    const count=new Map();
    for(const id of this.hands[seat]) { const t=this.typeOf(id); count.set(t,[...(count.get(t)||[]),id]); }
    return [...count.entries()].filter(([t,ids])=>ids.length>=4 && this.rules.koutsuOf(t)).map(([type,ids])=>({type,ids:ids.slice(0,4)}));
  }
  ankan(seat,type) {
    this._expect(seat,'turn');
    const o=this.ankanOptions(seat).find(o=>o.type===type);
    if(!o)throw new Error('ankan not possible');
    for(const id of o.ids)this.hands[seat].splice(this.hands[seat].indexOf(id),1);
    this.melds[seat].push({meld:this.rules.koutsuOf(type).idx,kind:'koutsu',call:'ankan',tiles:o.ids,claimed:null,from:null});
    const replacement=this.deadWall.replacement();
    this.hands[seat].push(replacement);
    this.drawn=replacement;this.justDrew=true;this.turnCount++;
    this.deadWall.reveal();
    this._riichiMemo=null;
    this.log({type:'ankan',seat,tiles:o.ids.slice()});
    this.log({type:'rinshan',seat});
    this.log({type:'dora',seat,indicator:this.deadWall.indicators.at(-1).id});
  }

  _draw(seat) {
    if (!this.wall.length || (this.newRules && this.rules.config.mode==='math2' && this.normalDraws[seat]>=24)) return this._endDraw();
    const id = this.wall.pop();
    this.tempFuriten[seat] = false; // 同巡のフリテンは自分の次の通常ツモで解除（嶺上ツモ・鳴きでは解除しない）
    if(this.normalDraws)this.normalDraws[seat]++;
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
      const p = { seat: this.current, type: 'turn', canTsumo: !!this.tsumoAnalysis(this.current) };
      // 新ルールだけ：暗カンの選択肢。旧ルールの pending() は従来と同じ形（キーを増やさない）
      if (this.newRules) p.ankan = this.ankanOptions(this.current);
      return p;
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

  // ---- フリテン（ruleset 2）----
  // 和了の形になる牌の種類（役の有無は問わない：鳴いた手で役のない牌も待ちに数える。一般的な麻雀と同じ）。
  // 自分の打牌番（手牌が1枚多い）では求めない（null）。
  shapeWaits(seat) {
    if (this.phase === 'turn' && this.current === seat) return null;
    return this.waitsOf(this.countsOf(this.hands[seat]), this.exposedMelds(seat), true);
  }
  // フリテンの状態：furiten（ロンできない）と理由。discard：待ちの牌を自分で捨てている（鳴かれた牌も含む）、
  // temporary：同巡の見逃し（次の自分の通常ツモまで）、riichi：リーチ後の見逃し（局の終わりまで）。
  // waits：待ちの種類（求めない局面では null）、inRiver：捨てている待ちの種類。ruleset 2 以外は常にフリテンなし。
  furitenOf(seat) {
    if (!this.furitenRule) return { furiten: false, reasons: [], waits: null, inRiver: [] };
    const waits = this.riichiWaits[seat] || this.shapeWaits(seat);
    const inRiver = waits ? waits.filter((t) => this.discarded[seat].has(t)) : [];
    const reasons = [];
    if (inRiver.length) reasons.push('discard');
    if (this.tempFuriten[seat]) reasons.push('temporary');
    if (this.riichiFuriten[seat]) reasons.push('riichi');
    return { furiten: reasons.length > 0, reasons, waits, inRiver };
  }
  _missRon(seat) {
    this.tempFuriten[seat] = true;
    if (this.riichi[seat]) this.riichiFuriten[seat] = true;
  }

  tsumoAnalysis(seat) {
    if (this.phase !== 'turn' || seat !== this.current || !this.justDrew) return null;
    return this.rules.analyzeWin(this.countsOf(this.hands[seat]), this.exposedMelds(seat), {closed:this.isClosed(seat)});
  }

  ronAnalysis(seat, tileId) {
    return this.rules.analyzeWin(this.countsOf([...this.hands[seat], tileId]), this.exposedMelds(seat), { ron: true,closed:this.isClosed(seat) });
  }

  get riichiEnabled() {
    return this.rules.config.rules.riichi === true;
  }

  // 手の内 counts（和了牌を除く8枚など）が聴牌か：和了できる牌の種類（待ち）の一覧。
  // 和了の判定は既存の analyzeWin（数式面子・刻子・特殊和了）をそのまま使う。
  // その種類の牌が手の内ですでに全部使われている待ち（物理的にあり得ない牌）は数えない。
  waitsOf(counts, exposed = [], closed = exposed.length === 0) {
    const out = [];
    for (let t = 0; t < counts.length; t++) {
      if (counts[t] >= this.rules.types[t].copies) continue;
      counts[t]++;
      const ok = !!this.rules.analyzeWin(counts, exposed, {closed});
      counts[t]--;
      if (ok) out.push(t);
    }
    return out;
  }

  // リーチを宣言できる打牌：[{ type: 牌の種類, ids: [その種類の手牌の id…], waits: [待ちの種類…] }]。
  // 条件：リーチの規則が有効・自分の打牌番・門前（公開面子なし）・未リーチ。9枚から1枚捨てた8枚が聴牌になる種類だけ。
  // 同じ局面では結果を再利用する（pending() の多い UI・AI から何度も呼ばれるため）。
  riichiOptions(seat) {
    if (!this.riichiEnabled || this.phase !== 'turn' || this.current !== seat || this.riichi[seat] || !this.isClosed(seat)) return [];
    const key = `${seat}:${this.events.length}`;
    if (this._riichiMemo && this._riichiMemo.key === key) return this._riichiMemo.opts;
    const counts = this.countsOf(this.hands[seat]);
    const opts = [];
    const seen = new Set();
    for (const id of this.hands[seat]) {
      const t = this.tileType[id];
      if (seen.has(t)) continue;
      seen.add(t);
      counts[t]--;
      const waits = this.waitsOf(counts, this.exposedMelds(seat), this.isClosed(seat));
      counts[t]++;
      if (waits.length) opts.push({ type: t, ids: this.hands[seat].filter((x) => this.tileType[x] === t), waits });
    }
    this._riichiMemo = { key, opts };
    return opts;
  }

  // チーとポンの合計回数の上限（旧設定の maxChi にも対応）
  get maxCalls() {
    const r = this.rules.config.rules;
    return r.maxCalls ?? r.maxChi;
  }

  // seat が tileId（上家の打牌）でチーできる面子の候補（数式面子のみ）
  chiOptions(seat, tileId) {
    if (this.riichi[seat] || this.melds[seat].length >= this.maxCalls) return []; // リーチ後はチー不可
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
    if (!this.rules.config.rules.pon || this.riichi[seat] || this.melds[seat].length >= this.maxCalls) return null; // リーチ後はポン不可
    const t = this.tileType[tileId];
    if (this.funcPonBan && this.rules.types[t].kind === 'func') return null; // ruleset 2：関数牌はポンできない（暗カンは可）
    const k = this.rules.koutsuOf(t);
    if (!k) return null;
    const use = this.hands[seat].filter((id) => this.tileType[id] === t).slice(0, 2);
    return use.length === 2 ? { meld: k.idx, use } : null;
  }

  // ---- 手番の行動 ----
  // opts.riichi：この打牌でリーチを宣言する（riichiOptions の種類の牌だけ）。
  // リーチ後の打牌はツモ切り（直前にツモった牌）だけ。それ以外はエンジンが拒否する（画面の制限だけに頼らない）。
  discard(seat, tileId, { riichi = false } = {}) {
    this._expect(seat, 'turn');
    const i = this.hands[seat].indexOf(tileId);
    if (i < 0) throw new Error('tile not in hand');
    if (this.riichi[seat]) {
      if (riichi) throw new Error('already in riichi');
      if (tileId !== this.drawn) throw new Error('riichi: tsumogiri only');
    }
    if (riichi) {
      const t = this.tileType[tileId];
      const opt = this.riichiOptions(seat).find((o) => o.type === t);
      if (!opt) throw new Error('riichi not possible');
      this.riichi[seat] = { tile: tileId, turn: this.turnCount };
      if (this.furitenRule) this.riichiWaits[seat] = opt.waits.slice(); // リーチ確定時の待ち（以後、手は変わらない）
      this.log({ type: 'riichi', seat, tile: tileId });
    }
    this.hands[seat].splice(i, 1);
    this.rivers[seat].push({ id: tileId, tsumogiri: tileId === this.drawn, ...(riichi ? { riichi: true } : {}) });
    if (this.furitenRule) this.discarded[seat].add(this.tileType[tileId]);
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
    const blocked = [];
    for (let k = 1; k < SEAT_COUNT; k++) {
      const s = next(from, k);
      let ron = !!this.ronAnalysis(s, tileId);
      // ruleset 2：フリテンならロンできない（ツモ和了はできる）。和了できる牌が出たのにロンしなかったことになるので、同巡のフリテンにもなる
      if (ron && this.furitenRule) {
        const f = this.furitenOf(s);
        // 画面の説明用（その席だけの情報。記録 events には残さない＝他家に知らせない）
        if (f.furiten) { ron = false; blocked.push(s); this.ronBlocked[s] = { tile: tileId, from, reasons: f.reasons.slice(), inRiver: f.inRiver.slice(), at: this.events.length }; }
      }
      const chi = k === 1 ? this.chiOptions(s, tileId) : [];
      const pon = this.ponOption(s, tileId);
      if (ron || chi.length || pon) queue.push({ seat: s, ron, chi, pon });
    }
    for (const s of blocked) this._missRon(s, tileId);
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
    // ruleset 2：ロンできたのに見送った（ポン・チーを選んだ場合も）→ 同巡のフリテン（リーチ中なら局の終わりまで）
    if (o.ron && this.furitenRule) this._missRon(seat, this.claim.tile);
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

  // 打牌（とその宣言の判断）が終わって次の人のツモへ進む。ロンが成立した場合はここに来ない（＝ロンが四家立直より優先）。
  _advance(from) {
    if (this.fourRiichiRule && this.riichi.every(Boolean)) return this._endDraw('four-riichi');
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
    analysis = this._withRiichi(seat, analysis);
    if(this.deadWall && !analysis.yakuman) {
      const winning=[...this.hands[seat],...this.melds[seat].flatMap(m=>m.tiles)];
      const count=this.deadWall.indicators.reduce((n,d)=>n+winning.filter(id=>this.typeOf(id)===d.type).length,0);
      analysis={...analysis,points:analysis.points+count,doraBonus:count};
    }
    this.result = { type: 'win', winner: seat, how, from, tile: tileId, analysis, points: analysis.points };
    this.log({ type: 'win', seat, how, from });
  }

  // リーチした人の和了：基本点に riichiBonus を加え、役の一覧に「リーチ」を加える。
  // 役満（通常の役・基本点を加算しない規則）には加算せず、riichi フラグだけを付ける。入力の analysis は変更しない。
  _withRiichi(seat, analysis) {
    if (!this.riichi[seat]) return analysis;
    const bonus = analysis.yakuman ? 0 : (this.rules.config.rules.riichiBonus ?? 1);
    const yaku = bonus ? [...analysis.yaku, { id: 'riichi', name: 'リーチ', points: bonus, yakuman: false, riichi: true }] : analysis.yaku;
    return { ...analysis, yaku, points: analysis.points + bonus, riichi: true, riichiBonus: bonus };
  }

  // reason：なし＝山切れ・数学Ⅱの24回（従来と同じ形）、'four-riichi'＝四家立直の途中流局（ruleset 2）。どちらも点数の移動なし
  _endDraw(reason = null) {
    this.phase = 'ended';
    this.claim = null;
    if (reason) {
      this.result = { type: 'draw', reason };
      this.log({ type: 'abortive-draw', reason });
      return;
    }
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
      riichi: this.riichi.map((r) => !!r), // リーチ宣言（公開情報）
      // 新ルールだけ：公開されたドラ表示牌（王牌の他の牌・嶺上牌は渡さない）と各席の通常ツモ回数。旧ルールの view は従来と同じ形
      ...(this.newRules ? {
        doraIndicators: this.doraIndicators.map((d) => ({ type: this.typeOf(d.id), doraType: d.type })),
        normalDraws: this.normalDraws.slice(),
      } : {}),
    };
  }

  // ---- 不変条件：全ての牌がちょうど1か所に存在し、手牌枚数が正しい ----
  checkInvariants() {
    const seen = new Array(this.tileType.length).fill(0);
    const mark = (id) => { seen[id]++; };
    this.wall.forEach(mark);
    if(this.deadWall)this.deadWall.allPhysical().forEach(mark);
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
        if ((m.call==='ankan' ? (ts.length!==4 || ts.some(t=>t!==ts[0]) || this.rules.koutsuOf(ts[0])?.idx!==m.meld) : this.rules.meldOf(...ts)?.idx!==m.meld)) throw new Error('invalid exposed meld');
      }
    }
    return true;
  }
}
