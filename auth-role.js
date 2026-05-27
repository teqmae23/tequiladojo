/**
 * auth-role.js — テキーラ道場 役割認証ユーティリティ
 * 各スタッフ向けページでこのスクリプトを読み込んで使用する
 *
 * 使い方:
 *   <script src="/auth-role.js"></script>
 *   <script>
 *     // staff/owner両方OK:
 *     AuthRole.requireStaff(auth, function(user, role) { ... });
 *
 *     // ownerのみ:
 *     AuthRole.requireOwner(auth, function(user, role) { ... });
 *   </script>
 */
var AuthRole = (function() {

  // ページ読み込み直後にログイン・アプリ画面を両方非表示にする
  // → onAuthStateChanged完了後に適切な画面を表示
  (function hideOnLoad(){
    var style = document.createElement('style');
    style.id = 'auth-role-hide';
    style.textContent = '#login-screen, #app, #main-screen { visibility: hidden !important; }';
    document.head.appendChild(style);
  })();

  function showScreens(){
    var el = document.getElementById('auth-role-hide');
    if(el) el.remove();
  }

  /**
   * IDトークンからroleを取得（キャッシュ付き、60秒で再取得）
   */
  async function getRole(user) {
    const log = [];
    // まずCustomClaimsを試みる
    try {
      const result = await user.getIdTokenResult(true);
      log.push('claims:' + JSON.stringify(result.claims));
      if (result.claims.role) { log.push('→ claims.role=' + result.claims.role); window._authLog=log; return result.claims.role; }
    } catch(e) { log.push('claims error:' + e.message); }
    // フォールバック: membersコレクションをemailで検索してroleを取得
    try {
      const db = firebase.firestore();
      const email = user.email || '';
      log.push('email:' + email);
      if (!email) { window._authLog=log; return null; }
      const snap = await db.collection('members').where('email','==',email).limit(1).get();
      log.push('members hit:' + snap.size);
      if (!snap.empty) {
        const data = snap.docs[0].data();
        log.push('memberId:' + snap.docs[0].id + ' role:' + data.role);
        if (data.role) { window._authLog=log; return data.role; }
      }
    } catch(e) { log.push('members error:' + e.message); }
    window._authLog = log;
    return null;
  }

  /**
   * ログイン画面を表示
   */
  function showLoginScreen(errorMsg) {
    var ls = document.getElementById('login-screen');
    var app = document.getElementById('app');
    if (ls) ls.style.display = 'flex';
    if (app) app.style.display = 'none';
    if (errorMsg) {
      var err = document.getElementById('lerr');
      if (err) {
        err.style.cssText='color:red;font-size:11px;margin-top:8px;word-break:break-all;white-space:pre-wrap;';
        err.textContent = errorMsg;
      }
      // フォールバック: body直下にdebug表示
      var dbg = document.getElementById('_auth_debug');
      if (!dbg) {
        dbg = document.createElement('div');
        dbg.id = '_auth_debug';
        dbg.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#000;color:#0f0;font-size:11px;padding:8px;z-index:99999;word-break:break-all;white-space:pre-wrap;max-height:40vh;overflow:auto;';
        document.body.appendChild(dbg);
      }
      dbg.textContent = '🔍 AUTH DEBUG:
' + errorMsg;
    }
  }

  /**
   * アクセス拒否画面を表示
   */
  function showDenied(message) {
    var app = document.getElementById('app');
    var ls  = document.getElementById('login-screen');
    if (ls) ls.style.display = 'none';
    if (app) {
      app.style.display = 'flex';
      // 既存のコンテンツの代わりに拒否メッセージを表示
      app.innerHTML =
        '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;background:#1a1a1a;color:#eee;font-family:sans-serif;">' +
        '<div style="font-size:48px">🚫</div>' +
        '<div style="font-size:18px;font-weight:600;">' + message + '</div>' +
        '<div style="font-size:13px;color:#aaa;">別のアカウントでログインしてください。</div>' +
        '<button onclick="firebase.auth().signOut().then(function(){location.reload();})" ' +
        'style="margin-top:8px;padding:10px 24px;background:#c8921e;border:none;border-radius:8px;color:#fff;font-size:14px;cursor:pointer;">ログアウト</button>' +
        '</div>';
    }
  }

  /**
   * requireStaff: owner または staff のみ許可
   * @param {firebase.auth.Auth} auth
   * @param {function(user, role)} onAllowed  — 許可時コールバック
   * @param {function()}          onSignedOut — ログアウト時コールバック（省略可）
   */
  function requireStaff(auth, onAllowed, onSignedOut) {
    auth.onAuthStateChanged(async function(user) {
      showScreens();
      if (!user) {
        if (onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      try {
        // 会員認証との分離: @tequiladojo.member のアドレスは会員専用 → 拒否
        if (user.email && user.email.indexOf('@tequiladojo.member') >= 0) {
          await auth.signOut();
          showDenied('スタッフ専用ページです');
          return;
        }
        let role = null;
        try {
          role = await getRole(user);
        } catch(tokenErr) {
          // トークン取得失敗時は一度だけリトライ
          console.warn('getRole retry:', tokenErr);
          await new Promise(r => setTimeout(r, 1000));
          try { role = await getRole(user); } catch(e2) { console.error('getRole failed:', e2); }
        }
        if (role === 'owner' || role === 'staff') {
          onAllowed(user, role);
        } else if (role === null) {
          const logMsg = (window._authLog||[]).join(' / ');
          if (onSignedOut) onSignedOut();
          else showLoginScreen('権限未設定。デバッグ: ' + logMsg);
        } else {
          await auth.signOut();
          showDenied('スタッフ専用ページです（権限がありません）');
        }
      } catch(e) {
        console.error('AuthRole.requireStaff:', e);
        // エラー時はログイン画面に戻す（showDeniedで詰まらせない）
        if (onSignedOut) onSignedOut();
        else showLoginScreen('認証エラー: ' + e.message);
      }
    });
  }

  /**
   * requireOwner: owner のみ許可
   */
  function requireOwner(auth, onAllowed, onSignedOut) {
    auth.onAuthStateChanged(async function(user) {
      showScreens();
      if (!user) {
        if (onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      try {
        if (user.email && user.email.indexOf('@tequiladojo.member') >= 0) {
          await auth.signOut();
          showDenied('オーナー専用ページです');
          return;
        }
        let role = null;
        try {
          role = await getRole(user);
        } catch(tokenErr) {
          console.warn('getRole retry:', tokenErr);
          await new Promise(r => setTimeout(r, 1000));
          try { role = await getRole(user); } catch(e2) { console.error('getRole failed:', e2); }
        }
        if (role === 'owner') {
          onAllowed(user, role);
        } else if (role === 'staff') {
          await auth.signOut();
          showDenied('このページはオーナー専用です');
        } else if (role === null) {
          if (onSignedOut) onSignedOut();
          else showLoginScreen('権限が設定されていません。管理者にお問い合わせください。');
        } else {
          await auth.signOut();
          showDenied('オーナー専用ページです（権限がありません）');
        }
      } catch(e) {
        console.error('AuthRole.requireOwner:', e);
        if (onSignedOut) onSignedOut();
        else showLoginScreen('認証エラー: ' + e.message);
      }
    });
  }

  /**
   * requireMember: 会員ログイン（member role、または @tequiladojo.member アドレス）
   * member_register.html / mypage.html 用
   */
  function requireMember(auth, onAllowed, onSignedOut) {
    auth.onAuthStateChanged(async function(user) {
      if (!user) {
        if (onSignedOut) onSignedOut();
        return;
      }
      try {
        const role = await getRole(user);
        const isMemberEmail = user.email && user.email.indexOf('@tequiladojo.member') >= 0;
        // staff/ownerが会員ページにアクセスしようとした場合は通す（プロフィール閲覧等）
        // ただしmember専用と明示する場合は拒否に変更可
        onAllowed(user, role);
      } catch(e) {
        console.error('AuthRole.requireMember:', e);
        if (onSignedOut) onSignedOut();
      }
    });
  }


/* ─────────────────────────────────────────────
 * getActiveSession
 *   現在の営業セッション（closeTimeがnull）を取得し、
 *   openTimeを返す。セッションがない場合はnullを返す。
 *
 *   使い方:
 *     const session = await AuthRole.getActiveSession(db);
 *     // session.openTime: "HHMM" 形式
 *     // session.openDate: "YYMMDD" 形式
 *     // session.sessionId: セッションID
 *     // session.sinceVisitDate: "YYMMDD"
 *     // session.sinceVisitTime: "HHMM"
 * ───────────────────────────────────────────── */
async function getActiveSession(db) {
  try {
    // closeTimeがnullのセッションを取得（複数ある場合は最新のopenTimeで判断）
    const snap = await db.collection('sessions').where('closeTime', '==', null).get();
    if (snap.empty) return null;

    // 複数ある場合は最も新しいopenTimeのものを選ぶ
    const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    sessions.sort((a, b) => (b.openTime || '').localeCompare(a.openTime || ''));
    const session = sessions[0];

    return {
      sessionId:     session.sessionId || session.id,
      openDate:      session.date || session.id.slice(0, 6),
      openTime:      session.openTime || '0000',
      sinceVisitDate: session.date || session.id.slice(0, 6),
      sinceVisitTime: session.openTime || '0000',
    };
  } catch(e) {
    console.warn('getActiveSession error:', e);
    return null;
  }
}

/* ─────────────────────────────────────────────
 * isVisitInSession
 *   visitがセッション開始以降かどうかを判定
 *   session: getActiveSession() の戻り値
 *   visit:   Firestoreのvisitドキュメント
 * ───────────────────────────────────────────── */
function isVisitInSession(visit, session) {
  if (!session) return true; // セッション取得失敗時は全件表示
  const vDate = visit.visitDate || visit.id.slice(0, 6) || '';
  const vTime = visit.visitTime || visit.checkInTime || '0000';
  if (vDate > session.openDate) return true;
  if (vDate < session.openDate) return false;
  // 同日の場合はopenTime以降
  return vTime >= session.openTime;
}

  
/* ─────────────────────────────────────────────
 * 営業時刻ユーティリティ
 *
 * 日またぎ営業に対応した時刻管理
 * 開店時刻を基準に、0時以降は2400加算して記録
 *
 * 例: 開店19:00, 翌01:30 → 2530 (25:30)
 *     開店19:00, 当日22:00 → 2200 (22:00)
 *
 * nowBusinessTime(sessionOpenTime)
 *   → 現在の営業時刻を HHMMSS 形式で返す（例: "253045"）
 *
 * formatBusinessTime(hhmmss)
 *   → "2530" → "25:30" の表示用文字列
 *
 * businessDate(sessionOpenTime, sessionDate)
 *   → 現在の営業日付を YYMMDD で返す（開店日付を引き継ぐ）
 * ───────────────────────────────────────────── */

function nowBusinessTime(sessionOpenTime) {
  if(!sessionOpenTime) {
    // セッションなし → 通常の時刻
    const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    return pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  const hh = d.getHours();
  const mm = d.getMinutes();
  const ss = d.getSeconds();
  const currentHHMM = hh * 100 + mm;
  const openHHMM = parseInt(sessionOpenTime.slice(0,4));

  if(currentHHMM < openHHMM) {
    // 開店時刻より小さい → 日またぎ → +2400
    const bizHH = hh + 24;
    return String(bizHH) + pad(mm) + pad(ss);
  }
  return pad(hh) + pad(mm) + pad(ss);
}

function businessDate(sessionOpenTime, sessionDate) {
  // 日またぎ中は開店日付を引き継ぐ
  if(!sessionOpenTime || !sessionDate) {
    const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    return String(d.getFullYear()).slice(2) + pad(d.getMonth()+1) + pad(d.getDate());
  }
  const d = new Date();
  const hh = d.getHours() * 100 + d.getMinutes();
  const openHHMM = parseInt(sessionOpenTime.slice(0,4));
  if(hh < openHHMM) {
    // 日またぎ中 → 開店日付を使う
    return sessionDate;
  }
  // 通常
  const pad = n => String(n).padStart(2,'0');
  return String(d.getFullYear()).slice(2) + pad(d.getMonth()+1) + pad(d.getDate());
}

function formatBusinessTime(hhmmss) {
  // "253045" → "25:30"
  // "201500" → "20:15"
  if(!hhmmss) return '';
  const h = parseInt(hhmmss.slice(0,2));
  const m = hhmmss.slice(2,4);
  // 秒は表示しない
  return h + ':' + m;
}

  return { requireStaff, requireOwner, requireMember, getRole, getActiveSession, isVisitInSession, nowBusinessTime, businessDate, formatBusinessTime };
})();
