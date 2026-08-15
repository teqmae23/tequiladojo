package com.tequiladojo.terminal

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.DiscoveryListener
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.callable.ReaderCallback
import com.stripe.stripeterminal.external.callable.TerminalListener
import com.stripe.stripeterminal.external.models.ConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionStatus
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration
import com.stripe.stripeterminal.external.models.PaymentIntent
import com.stripe.stripeterminal.external.models.PaymentStatus
import com.stripe.stripeterminal.external.models.Reader
import com.stripe.stripeterminal.external.models.TerminalException
import com.stripe.stripeterminal.log.LogLevel
import com.tequiladojo.terminal.databinding.ActivityMainBinding

/**
 * WisePad 3 で対面カード決済を行う最小アプリ。
 *
 * フロー: スタッフログイン → Terminal初期化 → Bluetoothで端末に接続
 *         → 金額入力 → 決済（読み取り〜確定）。
 *
 * ⚠️ Stripe Terminal Android SDK は版により API 名が変わります（例: 旧 processPayment /
 *    新 confirmPaymentIntent）。ビルドが通らない場合はインストール済みSDK版のドキュメントに
 *    合わせて、下の「// SDK-VERSION」印の箇所を調整してください。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private var discoverCancelable: Cancelable? = null
    private var connectedReader: Reader? = null

    // 会計画面（checkin.html）からの決済リクエスト待ち受け用
    private var queueListener: ListenerRegistration? = null
    private var processing = false

    private val prefs by lazy { getSharedPreferences("tdterminal", MODE_PRIVATE) }

    private val requiredPermissions = arrayOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.BLUETOOTH_SCAN,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.locationId.setText(prefs.getString("locationId", ""))

        b.btnLogin.setOnClickListener { login() }
        b.btnConnect.setOnClickListener { ensurePermissionsThen { discoverAndConnect() } }
        b.btnCharge.setOnClickListener { charge() }

        refreshUi()
    }

    // ── ① スタッフログイン（Firebase Auth） ──────────────────────
    private fun login() {
        val email = b.email.text.toString().trim()
        val pw = b.password.text.toString()
        if (email.isEmpty() || pw.isEmpty()) { toast("メールとパスワードを入力してください"); return }
        status("ログイン中...")
        FirebaseAuth.getInstance().signInWithEmailAndPassword(email, pw)
            .addOnSuccessListener { status("ログイン成功"); refreshUi() }
            .addOnFailureListener { status("ログイン失敗: ${it.message}") }
    }

    private fun isLoggedIn() = FirebaseAuth.getInstance().currentUser != null

    // ── ② Terminal 初期化 ─────────────────────────────────────────
    private fun initTerminalIfNeeded() {
        if (Terminal.isInitialized()) return
        Terminal.initTerminal(
            applicationContext,
            LogLevel.VERBOSE,
            TokenProvider(),
            object : TerminalListener {
                override fun onConnectionStatusChange(status: ConnectionStatus) {
                    runOnUiThread { refreshUi() }
                }
                override fun onPaymentStatusChange(status: PaymentStatus) {}
            }
        )
    }

    // ── ③ Bluetoothで WisePad 3 を探して接続 ─────────────────────
    private fun discoverAndConnect() {
        val locationId = b.locationId.text.toString().trim()
        if (locationId.isEmpty()) { toast("Location ID（tml_...）を入力してください"); return }
        prefs.edit().putString("locationId", locationId).apply()

        initTerminalIfNeeded()
        status("端末を検索中...（WisePad 3 の電源を入れてください）")

        // SDK-VERSION: 版により BluetoothDiscoveryConfiguration の引数が異なります
        val config = DiscoveryConfiguration.BluetoothDiscoveryConfiguration(0, false)
        discoverCancelable = Terminal.getInstance().discoverReaders(
            config,
            object : DiscoveryListener {
                override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                    val reader = readers.firstOrNull() ?: return
                    // 最初に見つかった端末に接続（複数運用ならシリアルで選別してください）
                    discoverCancelable?.cancel(object : Callback {
                        override fun onSuccess() {}
                        override fun onFailure(e: TerminalException) {}
                    })
                    connectTo(reader, locationId)
                }
            },
            object : Callback {
                override fun onSuccess() {}
                override fun onFailure(e: TerminalException) {
                    runOnUiThread { status("検索失敗: ${e.errorMessage}") }
                }
            }
        )
    }

    private fun connectTo(reader: Reader, locationId: String) {
        runOnUiThread { status("接続中: ${reader.serialNumber ?: ""}") }
        // SDK-VERSION: BluetoothConnectionConfiguration の引数・connectBluetoothReader の
        // シグネチャは版により異なります（listener を config に渡す版もあります）。
        val connConfig = ConnectionConfiguration.BluetoothConnectionConfiguration(locationId)
        Terminal.getInstance().connectBluetoothReader(
            reader,
            connConfig,
            /* listener = */ null,
            object : ReaderCallback {
                override fun onSuccess(r: Reader) {
                    connectedReader = r
                    runOnUiThread { status("接続完了: ${r.serialNumber ?: ""}（会計画面からの決済を待ち受け中）"); refreshUi() }
                    startQueueListener()
                }
                override fun onFailure(e: TerminalException) {
                    runOnUiThread { status("接続失敗: ${e.errorMessage}") }
                }
            }
        )
    }

    // ── ④ 決済（手入力ボタン） ─────────────────────────────────────
    private fun charge() {
        if (Terminal.getInstance().connectedReader == null) { toast("先に端末へ接続してください"); return }
        val amount = b.amount.text.toString().trim().toLongOrNull()
        if (amount == null || amount <= 0) { toast("金額（円）を入力してください"); return }
        if (processing) { toast("別の決済を処理中です"); return }
        processing = true
        startCharge(amount, null)
    }

    // 決済本体（手入力・会計画面リクエストの両方から呼ぶ）。
    // doc が非nullなら、成否を terminalPayments の該当ドキュメントに書き戻す。
    private fun startCharge(amount: Long, doc: DocumentReference?) {
        status("決済を準備中... ¥$amount")
        // 1) サーバーで PaymentIntent を作成し client_secret / id を得る
        val payload = hashMapOf<String, Any>("amount" to amount, "description" to "テキーラ道場 お会計")
        FirebaseFunctions.getInstance("us-central1")
            .getHttpsCallable("terminalCreatePaymentIntent")
            .call(payload)
            .addOnSuccessListener { result ->
                @Suppress("UNCHECKED_CAST")
                val data = result.data as? Map<String, Any?>
                val clientSecret = data?.get("clientSecret") as? String
                val piId = data?.get("id") as? String
                if (clientSecret.isNullOrEmpty()) { failPayment(doc, "PaymentIntent取得に失敗しました") }
                else collectAndConfirm(clientSecret, piId, amount, doc)
            }
            .addOnFailureListener { failPayment(doc, "PaymentIntent作成に失敗: ${it.message}") }
    }

    private fun collectAndConfirm(clientSecret: String, piId: String?, amount: Long, doc: DocumentReference?) {
        status("カードを端末にタッチ/挿入してください（¥$amount）")
        Terminal.getInstance().retrievePaymentIntent(clientSecret, object : PaymentIntentCallback {
            override fun onSuccess(paymentIntent: PaymentIntent) {
                Terminal.getInstance().collectPaymentMethod(paymentIntent, object : PaymentIntentCallback {
                    override fun onSuccess(collected: PaymentIntent) {
                        runOnUiThread { status("処理中...") }
                        // SDK-VERSION: v4 は confirmPaymentIntent、v3 以前は processPayment
                        Terminal.getInstance().confirmPaymentIntent(collected, object : PaymentIntentCallback {
                            override fun onSuccess(confirmed: PaymentIntent) {
                                succeedPayment(doc, piId ?: confirmed.id, amount)
                            }
                            override fun onFailure(e: TerminalException) {
                                failPayment(doc, "確定失敗: ${e.errorMessage}")
                            }
                        })
                    }
                    override fun onFailure(e: TerminalException) {
                        failPayment(doc, "読み取り失敗/中断: ${e.errorMessage}")
                    }
                })
            }
            override fun onFailure(e: TerminalException) {
                failPayment(doc, "PaymentIntent取得失敗: ${e.errorMessage}")
            }
        })
    }

    private fun succeedPayment(doc: DocumentReference?, piId: String?, amount: Long) {
        runOnUiThread { status("✅ 決済完了（¥$amount）"); b.amount.setText("") }
        doc?.update(
            mapOf(
                "status" to "succeeded",
                "paymentIntentId" to (piId ?: ""),
                "updatedAt" to FieldValue.serverTimestamp()
            )
        )
        processing = false
    }

    private fun failPayment(doc: DocumentReference?, msg: String) {
        runOnUiThread { status(msg) }
        doc?.update(
            mapOf(
                "status" to "failed",
                "errorMessage" to msg,
                "updatedAt" to FieldValue.serverTimestamp()
            )
        )
        processing = false
    }

    // ── ⑤ 会計画面（checkin.html）からの決済リクエストを待ち受け ──────
    // 会計画面が terminalPayments に status='pending' で作成 → ここで受けて
    // processing に更新 → WisePad 3 で決済 → succeeded/failed を書き戻す。
    private fun startQueueListener() {
        if (queueListener != null) return
        queueListener = FirebaseFirestore.getInstance()
            .collection("terminalPayments")
            .whereEqualTo("status", "pending")
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) return@addSnapshotListener
                if (processing) return@addSnapshotListener
                if (!Terminal.isInitialized() || Terminal.getInstance().connectedReader == null) return@addSnapshotListener
                // createdAt 昇順で最初の pending を処理（1件ずつ）
                val d = snap.documents
                    .sortedBy { it.getTimestamp("createdAt")?.seconds ?: Long.MAX_VALUE }
                    .firstOrNull() ?: return@addSnapshotListener
                val amount = d.getLong("amount") ?: return@addSnapshotListener
                if (amount <= 0) return@addSnapshotListener
                processing = true
                val ref = d.reference
                ref.update(
                    mapOf(
                        "status" to "processing",
                        "updatedAt" to FieldValue.serverTimestamp()
                    )
                ).addOnSuccessListener {
                    runOnUiThread { b.amount.setText(amount.toString()) }
                    startCharge(amount, ref)
                }.addOnFailureListener {
                    processing = false
                }
            }
    }

    private fun stopQueueListener() { queueListener?.remove(); queueListener = null }

    override fun onDestroy() {
        super.onDestroy()
        stopQueueListener()
    }

    // ── 権限・UI ──────────────────────────────────────────────────
    private fun ensurePermissionsThen(action: () -> Unit) {
        val missing = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) { action(); return }
        pendingAction = action
        ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_PERMS)
    }

    private var pendingAction: (() -> Unit)? = null

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERMS) {
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                pendingAction?.invoke()
            } else {
                status("Bluetooth/位置情報の権限が必要です")
            }
            pendingAction = null
        }
    }

    private fun refreshUi() {
        val loggedIn = isLoggedIn()
        b.loginBox.visibility = if (loggedIn) android.view.View.GONE else android.view.View.VISIBLE
        b.opBox.visibility = if (loggedIn) android.view.View.VISIBLE else android.view.View.GONE
        val connected = Terminal.isInitialized() && Terminal.getInstance().connectedReader != null
        b.btnCharge.isEnabled = connected
        b.connState.text = if (connected) "端末: 接続済み" else "端末: 未接続"
    }

    private fun status(s: String) { b.status.text = s }
    private fun toast(s: String) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show() }

    companion object { private const val REQ_PERMS = 1001 }
}
