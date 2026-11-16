// games/mathjong（数雀のオンライン対戦）のルール断片。docs/79「5.3」・docs/80「3」。
// scripts/prepare-mathjong-rules.cjs が、所有者の書き出した現行ルール全文の games の下へ「games/mathjong だけ」を追加する。
// 既存の枝（games/factor・games/iroyomi など）には触れない。本番への適用は所有者が Console で行う（段階4）。
//
// 方針：
// ・rooms/$code には読取の権限を付けない（親で読取を許すと子で取り消せないため）。子ごとに付ける。
// ・priv/$seat（手牌など）はその席の本人の uid だけが読める。pub（公開状態）は参加者だけが読み、ホストだけが書く。
// ・act/$seat（行動）は本人が追記するだけ。host（ホストの秘密）はホストだけ。
// ・期限切れの部屋は、認証済みなら誰でも「丸ごと削除」だけできる（サーバーなしの掃除）。ホストは自分の部屋を丸ごと削除できる。
const ROOM = "root.child('games/mathjong/rooms/' + $code)";
const META = `${ROOM}.child('meta')`;
const IS_HOST = `${META}.child('hostUid').val() === auth.uid`;
const SEAT_UID = (s) => `${ROOM}.child('seats/' + ${s} + '/uid').val()`;
const IS_MEMBER = `(${[0, 1, 2, 3].map((s) => `${SEAT_UID(`'${s}'`)} === auth.uid`).join(' || ')})`;
const LIVE = `${META}.exists() && ${META}.child('expiresAt').val() > now`;
const TTL = 12 * 60 * 60 * 1000; // 部屋の期限（12時間）
const SKEW = 5 * 60 * 1000; // 端末の時計のずれの許容（作成時刻の検査用）
const no = { '.validate': false };

module.exports = {
  // 機能の停止スイッチ（Console からだけ書く）：{ enabled: true } のときだけ入口が開く
  config: { '.read': 'auth != null', '.write': false },
  rooms: {
    $code: {
      '.write': `auth != null && data.exists() && !newData.exists() && (data.child('meta/expiresAt').val() < now || data.child('meta/hostUid').val() === auth.uid)`,
      '.validate': '$code.matches(/^[A-HJ-NP-Z2-9]{6}$/)',
      meta: {
        '.read': 'auth != null',
        // 作成：無い部屋を自分をホストにして作る。変更：ホストだけ（ホストの付け替え・期限の延長・作成時刻の変更は不可）
        '.write': `auth != null && newData.exists() && newData.child('hostUid').val() === auth.uid && (!data.exists() || data.child('hostUid').val() === auth.uid)`,
        '.validate': `newData.hasChildren(['hostUid', 'status', 'mode', 'length', 'ruleset', 'appVersion', 'createdAt', 'expiresAt'])
          && (!data.exists() || (newData.child('createdAt').val() === data.child('createdAt').val() && newData.child('expiresAt').val() === data.child('expiresAt').val()))
          && (data.exists() || (newData.child('createdAt').val() >= now - ${SKEW} && newData.child('createdAt').val() <= now + ${SKEW}
              && newData.child('status').val() === 'lobby'))`,
        hostUid: { '.validate': 'newData.isString()' },
        status: { '.validate': "newData.isString() && newData.val().matches(/^(lobby|playing|closed)$/)" },
        mode: { '.validate': "newData.isString() && newData.val().matches(/^math[12]$/)" },
        length: { '.validate': 'newData.val() === 1 || newData.val() === 4 || newData.val() === 8' },
        ruleset: { '.validate': 'newData.val() === 2' },
        appVersion: { '.validate': 'newData.isString() && newData.val().length >= 1 && newData.val().length <= 16' },
        createdAt: { '.validate': 'newData.isNumber()' },
        expiresAt: { '.validate': `newData.isNumber() && newData.val() <= newData.parent().child('createdAt').val() + ${TTL}` },
        startedAt: { '.validate': 'newData.isNumber()' },
        matchNo: { '.validate': 'newData.isNumber() && newData.val() >= 0' },
        $other: no,
      },
      seats: {
        '.read': 'auth != null',
        $seat: {
          // 空席を自分の uid で取る（ロビー中・まだ席がない人だけ）／自分の席の名前の更新・ロビー中の離席／ホストはすべての席
          '.write': `auth != null && $seat.matches(/^[0-3]$/) && ${LIVE} && (
              ${IS_HOST}
              || (!data.exists() && newData.child('uid').val() === auth.uid && ${META}.child('status').val() === 'lobby' && !${IS_MEMBER})
              || (data.child('uid').val() === auth.uid && newData.exists() && newData.child('uid').val() === auth.uid)
              || (data.child('uid').val() === auth.uid && !newData.exists() && ${META}.child('status').val() === 'lobby'))`,
          '.validate': "newData.hasChildren(['uid', 'name', 'kind', 'joinedAt'])",
          uid: { '.validate': 'newData.isString()' },
          name: { '.validate': 'newData.isString() && newData.val().length >= 1 && newData.val().length <= 10' },
          kind: { '.validate': "newData.val() === 'human'" },
          joinedAt: { '.validate': 'newData.isNumber()' },
          $other: no,
        },
      },
      // 接続の有無（onDisconnect で online:false）。本人だけが書く
      presence: {
        '.read': 'auth != null',
        $uid: {
          '.write': `auth != null && auth.uid === $uid && ${LIVE}`,
          '.validate': "newData.hasChildren(['online', 'at'])",
          online: { '.validate': 'newData.isBoolean()' },
          at: { '.validate': 'newData.isNumber()' },
          $other: no,
        },
      },
      // 公開状態：参加者だけが読み、ホストだけが書く（段階2で中身を使う）
      pub: { '.read': IS_MEMBER, '.write': `auth != null && ${IS_HOST}` },
      // 席ごとの非公開（手牌・自分の選択肢）：その席の本人だけが読む。書くのはホスト
      priv: { $seat: { '.read': `auth != null && ${SEAT_UID('$seat')} === auth.uid`, '.write': `auth != null && ${IS_HOST}` } },
      // 行動：本人が追記するだけ（上書き・削除は不可）。ホストと本人が読む
      act: {
        $seat: {
          '.read': `auth != null && (${IS_HOST} || ${SEAT_UID('$seat')} === auth.uid)`,
          $n: {
            '.write': `auth != null && !data.exists() && newData.exists() && ${SEAT_UID('$seat')} === auth.uid`,
            '.validate': "newData.hasChildren(['k', 'sid', 'at']) && newData.child('k').isString() && newData.child('k').val().matches(/^(discard|tsumo|ankan|ron|pon|chi|pass|ready|away|back)$/)",
          },
        },
      },
      // ホストの秘密（seedBase・行動の記録）：ホストだけ
      host: { '.read': `auth != null && ${IS_HOST}`, '.write': `auth != null && ${IS_HOST}` },
      $other: no,
    },
  },
};
