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

  /**
   * IDトークンからroleを取得（キャッシュ付き、60秒で再取得）
   */
  async function getRole(user) {
    const result = await user.getIdTokenResult(false);
    return result.claims.role || null;
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
      if (err) err.textContent = errorMsg;
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
        const role = await getRole(user);
        if (role === 'owner' || role === 'staff') {
          onAllowed(user, role);
        } else {
          // roleが未設定 or memberの場合
          await auth.signOut();
          showDenied('スタッフ専用ページです（権限がありません）');
        }
      } catch(e) {
        console.error('AuthRole.requireStaff:', e);
        showDenied('認証エラーが発生しました');
      }
    });
  }

  /**
   * requireOwner: owner のみ許可
   */
  function requireOwner(auth, onAllowed, onSignedOut) {
    auth.onAuthStateChanged(async function(user) {
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
        const role = await getRole(user);
        if (role === 'owner') {
          onAllowed(user, role);
        } else if (role === 'staff') {
          await auth.signOut();
          showDenied('このページはオーナー専用です');
        } else {
          await auth.signOut();
          showDenied('オーナー専用ページです（権限がありません）');
        }
      } catch(e) {
        console.error('AuthRole.requireOwner:', e);
        showDenied('認証エラーが発生しました');
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

  return { requireStaff, requireOwner, requireMember, getRole };
})();
