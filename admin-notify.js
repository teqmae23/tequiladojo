/**
 * admin-notify.js — 管理者通知（共通・自動実行）
 *
 * 会員からのアクション（承認・対応待ち）を1つの通知欄にまとめて表示する共通モジュール。
 * 管理系ページ（開店閉店・来場者一覧・注文一覧 など）の末尾で
 *   <script src="/admin-notify.js?v=YYYYMMDD"></script>
 * を読み込むだけで、画面左下に通知ベルと通知パネルを表示する。
 *
 * 表示対象（現行）:
 *   - 予約承認待ち      reservationRequests (status=='pending') → reservations.html
 *   - ボトル登録依頼    bottleRequests      (status=='pending') → admin_bottle_requests.html
 *   - BARマスタ承認依頼 bars                (status=='pending') → admin_bars.html
 *
 * 将来追加予定（後日実装。SOURCES に1件足すだけで対応可能）:
 *   - オンライン奢り / 当日予約 / 会員メッセージ など
 *
 * 権限: staff / owner のみに表示（members.role で判定）。会員には出さない。
 * 通知は「未処理キュー」そのもの（onSnapshotで常時同期）。処理されると自動的に消える。
 */
(function () {
  'use strict';
  if (window.__adminNotifyLoaded) return;
  window.__adminNotifyLoaded = true;

  // ── 通知ソース定義（ここに足せば通知種別を追加できる） ─────────────
  //  coll   : Firestoreコレクション名
  //  wq     : where句 [field, op, value]（省略時は全件）
  //  href   : 通知/明細をタップした時の遷移先
  //  icon   : 見出しアイコン
  //  label  : 見出しラベル
  //  line   : 明細1行の本文を返す関数 (data) => htmlString（escは各自）
  var SOURCES = [
    {
      key: 'reservationRequests', coll: 'reservationRequests', wq: ['status', '==', 'pending'],
      href: 'reservations.html', icon: '📅', label: '予約承認待ち',
      line: function (d) {
        var who = esc(d.memberName || '（会員）') + (d.memberId ? '（' + esc(d.memberId) + '）' : '');
        var when = fmtYmd(d.reservationDate) + ' ' + fmtHms(d.startTime) + '〜' + fmtHms(d.endTime);
        var g = d.guests ? '・' + esc(String(d.guests)) + '名' : '';
        return '<b>' + who + '</b><span class="an-sub">' + when + g + '</span>';
      }
    },
    {
      key: 'bottleRequests', coll: 'bottleRequests', wq: ['status', '==', 'pending'],
      href: 'admin_bottle_requests.html', icon: '🍾', label: 'ボトル登録依頼',
      line: function (d) {
        var who = esc(d.memberName || '') + (d.memberId ? '（' + esc(d.memberId) + '）' : '');
        return '<b>' + esc(d.name || '(銘柄名未設定)') + '</b>' + (who ? '<span class="an-sub">申請: ' + who + '</span>' : '');
      }
    },
    {
      key: 'bars', coll: 'bars', wq: ['status', '==', 'pending'],
      href: 'admin_bars.html', icon: '🍸', label: 'BARマスタ承認依頼',
      line: function (d) {
        var nm = d.nameJa || d.nameEn || '(名称未設定)';
        var by = d.createdByName ? '<span class="an-sub">申請: ' + esc(d.createdByName) + '</span>' : '';
        return '<b>' + esc(nm) + '</b>' + by;
      }
    }
    // 将来: { key:'onlineTreat', ... }, { key:'sameDayReservation', ... }, { key:'memberMessages', ... }
  ];

  var MAX_ITEMS_PER_SOURCE = 6; // パネル内で各種別に表示する最大明細数
  var state = {};               // key -> [docs]
  var db = null, open = false, built = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtYmd(v) { // "YYMMDD" -> "YY/MM/DD"
    v = String(v || ''); return v.length >= 6 ? v.slice(0, 2) + '/' + v.slice(2, 4) + '/' + v.slice(4, 6) : (v || '—');
  }
  function fmtHms(v) { // "HHMMSS" -> "HH:MM"
    v = String(v || ''); return v.length >= 4 ? v.slice(0, 2) + ':' + v.slice(2, 4) : (v || '');
  }

  function injectStyles() {
    if (document.getElementById('admin-notify-css')) return;
    var css = ''
      + '#an-root{position:fixed;left:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:150;font-family:"Noto Sans JP",system-ui,sans-serif}'
      + '#an-bell{width:52px;height:52px;border-radius:50%;border:none;background:#7a5610;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 16px rgba(24,17,10,.35);display:flex;align-items:center;justify-content:center;position:relative;transition:transform .1s}'
      + '#an-bell:hover{transform:translateY(-2px)}'
      + '#an-bell.an-has{background:#b8471f}'
      + '#an-badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e23b2e;color:#fff;font-size:11px;font-weight:700;line-height:20px;text-align:center;box-shadow:0 0 0 2px #fff;display:none}'
      + '#an-panel{position:absolute;left:0;bottom:62px;width:360px;max-width:calc(100vw - 32px);max-height:70vh;overflow-y:auto;background:#fffdf9;border:1px solid #e4d9c6;border-radius:14px;box-shadow:0 12px 40px rgba(24,17,10,.28);display:none}'
      + '#an-root.an-open #an-panel{display:block}'
      + '.an-head{position:sticky;top:0;background:#241c0e;color:#f3e6c9;padding:12px 14px;font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;border-radius:14px 14px 0 0}'
      + '.an-head .an-x{margin-left:auto;background:none;border:none;color:rgba(243,230,201,.7);font-size:18px;cursor:pointer;line-height:1}'
      + '.an-empty{padding:26px 16px;text-align:center;color:#9b8b70;font-size:13px}'
      + '.an-grp{border-bottom:1px solid #efe6d6}'
      + '.an-grp:last-child{border-bottom:none}'
      + '.an-grp-h{display:flex;align-items:center;gap:8px;padding:10px 14px 6px;font-size:12px;font-weight:700;color:#6a5636}'
      + '.an-grp-ct{background:#efe1c6;color:#7a5610;border-radius:10px;font-size:11px;font-weight:700;padding:1px 8px}'
      + '.an-grp-open{margin-left:auto;font-size:11px;color:#1a6e58;text-decoration:none;border:1px solid #cfe6e2;border-radius:12px;padding:2px 9px}'
      + '.an-item{display:block;padding:8px 14px;text-decoration:none;color:#2c2114;font-size:13px;border-top:1px solid #f3ecdd}'
      + '.an-item:hover{background:#f7f0e2}'
      + '.an-item b{font-weight:600}'
      + '.an-sub{display:block;font-size:11px;color:#9b8b70;margin-top:1px}'
      + '.an-more{display:block;padding:7px 14px;font-size:11px;color:#7a5610;text-decoration:none;border-top:1px solid #f3ecdd}'
      + '@media (max-width:480px){#an-bell{width:48px;height:48px;font-size:20px}}';
    var st = document.createElement('style');
    st.id = 'admin-notify-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildUI() {
    if (built) return;
    built = true;
    injectStyles();
    var root = document.createElement('div');
    root.id = 'an-root';
    root.innerHTML =
      '<div id="an-panel"><div class="an-head">🔔 管理者通知 <span id="an-total"></span>'
      + '<button class="an-x" aria-label="閉じる">✕</button></div>'
      + '<div id="an-body"></div></div>'
      + '<button id="an-bell" aria-label="通知">🔔<span id="an-badge">0</span></button>';
    document.body.appendChild(root);
    document.getElementById('an-bell').addEventListener('click', function (e) {
      e.stopPropagation(); toggle();
    });
    root.querySelector('.an-x').addEventListener('click', function (e) {
      e.stopPropagation(); setOpen(false);
    });
    // パネル外クリックで閉じる
    document.addEventListener('click', function (e) {
      if (open && !root.contains(e.target)) setOpen(false);
    });
  }

  function setOpen(v) {
    open = v;
    var root = document.getElementById('an-root');
    if (root) root.classList.toggle('an-open', open);
  }
  function toggle() { setOpen(!open); }

  function total() {
    var n = 0;
    SOURCES.forEach(function (s) { n += (state[s.key] || []).length; });
    return n;
  }

  function render() {
    if (!built) return;
    var n = total();
    var badge = document.getElementById('an-badge');
    var bell = document.getElementById('an-bell');
    if (badge) { badge.style.display = n > 0 ? 'block' : 'none'; badge.textContent = n > 99 ? '99+' : String(n); }
    if (bell) bell.classList.toggle('an-has', n > 0);
    var tot = document.getElementById('an-total');
    if (tot) tot.textContent = n > 0 ? '（' + n + '件）' : '';

    var body = document.getElementById('an-body');
    if (!body) return;
    if (n === 0) { body.innerHTML = '<div class="an-empty">新しい通知はありません</div>'; return; }
    var html = '';
    SOURCES.forEach(function (s) {
      var arr = state[s.key] || [];
      if (!arr.length) return;
      html += '<div class="an-grp"><div class="an-grp-h">' + s.icon + ' ' + esc(s.label)
        + '<span class="an-grp-ct">' + arr.length + '</span>'
        + '<a class="an-grp-open" href="' + s.href + '">対応 →</a></div>';
      arr.slice(0, MAX_ITEMS_PER_SOURCE).forEach(function (d) {
        html += '<a class="an-item" href="' + s.href + '">' + s.line(d) + '</a>';
      });
      if (arr.length > MAX_ITEMS_PER_SOURCE) {
        html += '<a class="an-more" href="' + s.href + '">ほか ' + (arr.length - MAX_ITEMS_PER_SOURCE) + ' 件 →</a>';
      }
      html += '</div>';
    });
    body.innerHTML = html;
  }

  function subscribe() {
    SOURCES.forEach(function (s) {
      var q = db.collection(s.coll);
      if (s.wq) q = q.where(s.wq[0], s.wq[1], s.wq[2]);
      q.onSnapshot(function (snap) {
        var list = [];
        snap.forEach(function (doc) { list.push(Object.assign({ id: doc.id }, doc.data())); });
        // 新しい順（createdAt降順。無ければそのまま）
        list.sort(function (a, b) {
          var ta = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
          var tb = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
          return tb - ta;
        });
        state[s.key] = list;
        render();
      }, function (err) {
        // 権限が無い/インデックス等で失敗しても他ソースは動かす
        try { console.warn('[admin-notify] ' + s.coll + ' snapshot error:', err && err.message); } catch (e) {}
        state[s.key] = [];
        render();
      });
    });
  }

  function start() {
    buildUI();
    render();
    subscribe();
  }

  function waitForFirebase() {
    if (!window.firebase || !firebase.apps || !firebase.apps.length) {
      return setTimeout(waitForFirebase, 300);
    }
    var auth;
    try { auth = firebase.auth(); db = firebase.firestore(); } catch (e) { return; }
    var done = false;
    auth.onAuthStateChanged(function (user) {
      if (done) return;
      if (!user || user.isAnonymous) return;
      // staff/owner のみ表示（会員doc の role で判定）
      db.collection('members').where('authUid', '==', user.uid).limit(1).get()
        .then(function (snap) {
          if (done) return;
          var role = snap.empty ? null : (snap.docs[0].data() || {}).role;
          if (role === 'owner' || role === 'staff') { done = true; start(); }
        })
        .catch(function () {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForFirebase);
  } else {
    waitForFirebase();
  }
})();
