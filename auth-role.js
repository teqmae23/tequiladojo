/**
 * auth-role.js — テキーラ道場 役割認証
 */
var AuthRole = (function() {

  // ページ読み込み時に画面を隠す
  (function hideOnLoad(){
    var style = document.createElement('style');
    style.id = 'auth-role-hide';
    style.textContent = '#login-screen, #app, #main-screen { visibility: hidden !important; }';
    document.head.appendChild(style);
  })();

  function showScreens(){
    var s = document.getElementById('auth-role-hide');
    if(s) s.remove();
  }

  function showLoginScreen(msg){
    showScreens();
    var ls = document.getElementById('login-screen');
    var app = document.getElementById('app');
    if(ls) ls.style.display = 'flex';
    if(app) app.style.display = 'none';
    if(msg){
      var err = document.getElementById('lerr');
      if(err) err.textContent = msg;
    }
  }

  function showDenied(msg){
    showScreens();
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666;padding:20px;text-align:center;">' + (msg||'アクセス権限がありません') + '</div>';
  }

  // roleを取得
  async function getRole(user){
    var db = firebase.firestore();
    // 1. staffRoles/{uid} を直接取得（最も確実）
    try {
      var doc = await db.collection('staffRoles').doc(user.uid).get();
      if(doc.exists && doc.data().role) return doc.data().role;
    } catch(e){}
    // 2. Custom Claims
    try {
      var result = await user.getIdTokenResult(true);
      if(result.claims.role) return result.claims.role;
    } catch(e){}
    // 3. members/{memberId} をauthUidで検索
    try {
      var snap = await db.collection('members').where('authUid','==',user.uid).limit(1).get();
      if(!snap.empty && snap.docs[0].data().role) return snap.docs[0].data().role;
    } catch(e){}
    return null;
  }

  function requireStaff(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      showScreens();
      if(!user){
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      // 会員専用アドレスは拒否
      if(user.email && user.email.indexOf('@tequiladojo.member') >= 0){
        await auth.signOut();
        showDenied('スタッフ専用ページです');
        return;
      }
      var role = null;
      try { role = await getRole(user); } catch(e){}
      if(role === 'owner' || role === 'staff'){
        onAllowed(user, role);
      } else {
        var msg = role ? 'アクセス権限がありません（role:' + role + '）' : '権限が設定されていません（email:' + user.email + '）';
        await auth.signOut();
        showLoginScreen(msg);
      }
    });
  }

  function requireOwner(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      showScreens();
      if(!user){
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      var role = null;
      try { role = await getRole(user); } catch(e){}
      if(role === 'owner'){
        onAllowed(user, role);
      } else {
        var msg = 'オーナー権限が必要です（role:' + role + '）';
        await auth.signOut();
        showLoginScreen(msg);
      }
    });
  }

  function requireMember(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      showScreens();
      if(!user){
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      onAllowed(user, null);
    });
  }

  return { requireStaff: requireStaff, requireOwner: requireOwner, requireMember: requireMember };
})();
