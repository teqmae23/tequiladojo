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

  // membersコレクションからroleを取得
  async function getRole(user){
    // 1. Custom Claims確認
    try {
      var result = await user.getIdTokenResult(true);
      if(result.claims.role) return result.claims.role;
    } catch(e){}
    var db = firebase.firestore();
    // 2. authUidフィールドで検索
    try {
      var snap = await db.collection('members').where('authUid','==',user.uid).limit(1).get();
      if(!snap.empty && snap.docs[0].data().role) return snap.docs[0].data().role;
    } catch(e){}
    // 3. emailフィールドで検索
    try {
      var email = user.email || '';
      if(email){
        var snap2 = await db.collection('members').where('email','==',email).limit(1).get();
        if(!snap2.empty && snap2.docs[0].data().role) return snap2.docs[0].data().role;
      }
    } catch(e){}
    // 4. memberIndexからmemberIdを取得してdoc直接参照
    try {
      var email = user.email || '';
      if(email){
        var idxSnap = await db.collection('memberIndex').where('email','==',email).limit(1).get();
        if(!idxSnap.empty){
          var mid = idxSnap.docs[0].id;
          var mDoc = await db.collection('members').doc(mid).get();
          if(mDoc.exists && mDoc.data().role) return mDoc.data().role;
        }
      }
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
