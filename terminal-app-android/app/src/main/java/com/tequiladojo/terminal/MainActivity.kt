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
import com.stripe.stripeterminal.external.callable.MobileReaderListener
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.callable.ReaderCallback
import com.stripe.stripeterminal.external.callable.TerminalListener
import com.stripe.stripeterminal.external.models.ConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionStatus
import com.stripe.stripeterminal.external.models.DisconnectReason
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

    // 前回の決済の「読み取り待ち」が端末に残ったまま次の決済に進むと、WisePad 3 に
    // 前回（エラー/中止）の金額が出続ける。読み取り中の操作を保持し、次の決済の前に必ず中止する。
    private var collectCancelable: Cancelable? = null
    private var currentDoc: DocumentReference? = null
    private var currentDocListener: ListenerRegistration? = null
    // 会計画面の「端末リセット」指示（terminalControl/reset）の待ち受け
    private var controlListener: ListenerRegistration? = null
    private val appStartedAtSec = System.currentTimeMillis() / 1000
    // pending のまま放置された古いリクエストは処理しない（古い金額が流れてくるのを防ぐ）
    private val pendingMaxAgeSec = 3 * 60L

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
        b.btnReset.setOnClickListener { resetProcessing() }

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

    // WisePad 3 の予期せぬ切断からの自動再接続を受け取るリスナー。
    // 会計途中に Bluetooth が切れる（＝決済時に "No active reader"）対策の要。
    private val readerListener = object : MobileReaderListener {
        override fun onReaderReconnectStarted(reader: Reader, cancelReconnect: Cancelable, reason: DisconnectReason) {
            runOnUiThread { status("⚠ 端末が切断されました。自動再接続中…"); refreshUi() }
        }
        override fun onReaderReconnectSucceeded(reader: Reader) {
            connectedReader = reader
            // 途中で切れた決済は失敗扱いのまま。フラグを戻して次の決済を受けられるようにする。
            processing = false
            runOnUiThread { status("✅ 再接続しました（会計画面からの決済を待ち受け中）"); refreshUi() }
        }
        override fun onReaderReconnectFailed(reader: Reader) {
            connectedReader = null
            processing = false
            runOnUiThread { status("❌ 再接続に失敗しました。もう一度「WisePad 3 に接続」を押してください"); refreshUi() }
        }
    }

    private fun connectTo(reader: Reader, locationId: String) {
        runOnUiThread { status("接続中: ${reader.serialNumber ?: ""}") }
        // SDK v4: connectReader に統一。listener（MobileReaderListener）と
        // autoReconnectOnUnexpectedDisconnect は ConnectionConfiguration に渡す。
        val connConfig = ConnectionConfiguration.BluetoothConnectionConfiguration(
            locationId,
            /* autoReconnectOnUnexpectedDisconnect = */ true,
            /* bluetoothReaderListener = */ readerListener
        )
        Terminal.getInstance().connectReader(
            reader,
            connConfig,
            object : ReaderCallback {
                override fun onSuccess(r: Reader) {
                    connectedReader = r
                    processing = false
                    runOnUiThread { status("接続完了: ${r.serialNumber ?: ""}（会計画面からの決済を待ち受け中）"); refreshUi() }
                    startQueueListener()
                    startControlListener()
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
        // 手入力決済も terminalPayments に記録する（source='app'）。会計画面経由(source='checkout')
        // と区別できるようにし、成否は startCharge → succeed/failPayment がこの doc に書き戻す。
        val ref = FirebaseFirestore.getInstance().collection("terminalPayments").document()
        ref.set(
            mapOf(
                "amount" to amount,
                "currency" to "jpy",
                "status" to "processing",
                "source" to "app",
                "description" to "テキーラ道場 端末手入力",
                "visitKeys" to emptyList<String>(),
                "requestedByUid" to (FirebaseAuth.getInstance().currentUser?.uid),
                "paymentIntentId" to null,
                "errorMessage" to null,
                "createdAt" to FieldValue.serverTimestamp(),
                "updatedAt" to FieldValue.serverTimestamp()
            )
        ).addOnSuccessListener {
            startCharge(amount, ref)
        }.addOnFailureListener {
            // 記録に失敗しても決済自体は続行（ログなしのフォールバック）。
            startCharge(amount, null)
        }
    }

    // 決済本体（手入力・会計画面リクエストの両方から呼ぶ）。
    // doc が非nullなら、成否を terminalPayments の該当ドキュメントに書き戻す。
    private fun startCharge(amount: Long, doc: DocumentReference?) {
        // 端末に前回の読み取り待ちが残っていれば、必ず中止してから新しい決済を始める
        cancelInFlight {
            currentDoc = doc
            watchCurrentDoc(doc)
            startChargeInner(amount, doc)
        }
    }

    private fun startChargeInner(amount: Long, doc: DocumentReference?) {
        // 事前チェック: 端末が実際に接続状態か（切断中なら空振り決済を避け、明確に失敗させる）。
        val notConnected = !Terminal.isInitialized() ||
            Terminal.getInstance().connectedReader == null ||
            Terminal.getInstance().connectionStatus != ConnectionStatus.CONNECTED
        if (notConnected) {
            connectedReader = null
            runOnUiThread { refreshUi() }
            failPayment(doc, "端末が未接続です。「WisePad 3 に接続」で再接続してください")
            return
        }
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
                collectCancelable = Terminal.getInstance().collectPaymentMethod(paymentIntent, object : PaymentIntentCallback {
                    override fun onSuccess(collected: PaymentIntent) {
                        collectCancelable = null
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

    // 中止・置き換え済みの古い決済のコールバック（遅れて届く失敗通知など）は無視する
    private fun isCurrent(doc: DocumentReference?) = doc?.id == currentDoc?.id

    private fun succeedPayment(doc: DocumentReference?, piId: String?, amount: Long) {
        // 成功は（古い決済であっても）実際に課金されているので必ず記録する
        if (!isCurrent(doc)) {
            doc?.update(mapOf("status" to "succeeded", "paymentIntentId" to (piId ?: ""), "updatedAt" to FieldValue.serverTimestamp()))
            return
        }
        collectCancelable = null
        clearCurrentDoc()
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
        if (!isCurrent(doc)) return // 置き換え済みの決済の失敗通知（canceled のまま残す）
        collectCancelable = null
        clearCurrentDoc()
        // 失敗した金額を入力欄に残さない（次の手入力決済で前回の金額が使われるのを防ぐ）
        runOnUiThread { status(msg); b.amount.setText("") }
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
                val nowSec = System.currentTimeMillis() / 1000
                // 古い pending は処理せずキャンセル扱いにする（以前の会計の金額が流れてくるのを防ぐ）
                val fresh = snap.documents.filter { doc ->
                    val created = doc.getTimestamp("createdAt")?.seconds ?: return@filter true // 書き込み直後(未確定)は新しいもの
                    if (nowSec - created > pendingMaxAgeSec) {
                        doc.reference.update(mapOf(
                            "status" to "canceled",
                            "errorMessage" to "expired（受信が遅れたため自動キャンセル）",
                            "updatedAt" to FieldValue.serverTimestamp()
                        ))
                        false
                    } else true
                }
                // 新しい順で最新の1件だけを処理し、それより古い pending はキャンセル
                val sorted = fresh.sortedByDescending { it.getTimestamp("createdAt")?.seconds ?: Long.MAX_VALUE }
                val d = sorted.firstOrNull() ?: return@addSnapshotListener
                sorted.drop(1).forEach { old ->
                    old.reference.update(mapOf(
                        "status" to "canceled",
                        "errorMessage" to "superseded（新しい会計で自動キャンセル）",
                        "updatedAt" to FieldValue.serverTimestamp()
                    ))
                }
                if (processing) {
                    if (currentDoc?.id == d.id) return@addSnapshotListener
                    // 処理中に新しい会計が来た＝前の決済は放棄されている。前の読み取りを中止して新しい方を処理
                    currentDoc?.update(mapOf(
                        "status" to "canceled",
                        "errorMessage" to "superseded（新しい会計で自動キャンセル）",
                        "updatedAt" to FieldValue.serverTimestamp()
                    ))
                    clearCurrentDoc()
                    processing = false
                }
                val amount = d.getLong("amount") ?: return@addSnapshotListener
                if (amount <= 0) return@addSnapshotListener
                // 端末未接続なら黙って無視せず、会計画面に理由を返す（無反応で固まらせない）。
                if (!Terminal.isInitialized() || Terminal.getInstance().connectedReader == null) {
                    d.reference.update(
                        mapOf(
                            "status" to "failed",
                            "errorMessage" to "端末が接続されていません。アプリで「WisePad 3 に接続」を押してから再送信してください。",
                            "updatedAt" to FieldValue.serverTimestamp()
                        )
                    )
                    runOnUiThread { status("⚠ 会計から決済要求がありましたが端末が未接続です。接続してください。") }
                    return@addSnapshotListener
                }
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

    private fun stopQueueListener() {
        queueListener?.remove(); queueListener = null
        controlListener?.remove(); controlListener = null
    }

    // 読み取り中（カード待ち）の操作があれば中止し、終わってから next を実行する。
    private fun cancelInFlight(next: () -> Unit) {
        val c = collectCancelable
        collectCancelable = null
        if (c == null || c.isCompleted) { next(); return }
        c.cancel(object : Callback {
            override fun onSuccess() { runOnUiThread { next() } }
            override fun onFailure(e: TerminalException) { runOnUiThread { next() } }
        })
    }

    // 処理中ドキュメントが会計画面から canceled にされたら、端末の読み取りも止める
    private fun watchCurrentDoc(doc: DocumentReference?) {
        currentDocListener?.remove(); currentDocListener = null
        if (doc == null) return
        currentDocListener = doc.addSnapshotListener { snap, _ ->
            if (snap == null || !snap.exists()) return@addSnapshotListener
            if (snap.getString("status") == "canceled" && currentDoc?.id == doc.id) {
                cancelInFlight {
                    clearCurrentDoc()
                    processing = false
                    b.amount.setText("")
                    status("会計画面で中止されました（決済の待ち受けに戻りました）")
                }
            }
        }
    }

    private fun clearCurrentDoc() {
        currentDocListener?.remove(); currentDocListener = null
        currentDoc = null
    }

    // 会計画面の「端末リセット」ボタン → terminalControl/reset.resetAt が更新されたらリセット
    private fun startControlListener() {
        if (controlListener != null) return
        controlListener = FirebaseFirestore.getInstance()
            .collection("terminalControl").document("reset")
            .addSnapshotListener { snap, _ ->
                val at = snap?.getTimestamp("resetAt")?.seconds ?: return@addSnapshotListener
                if (at < appStartedAtSec) return@addSnapshotListener // アプリ起動前の指示は無視
                if (at <= (prefs.getLong("lastResetAt", 0L))) return@addSnapshotListener
                prefs.edit().putLong("lastResetAt", at).apply()
                runOnUiThread { resetProcessing() }
            }
    }

    // 決済が途中で止まって「別の決済を処理中です」から戻らない時の手動リセット。
    // アプリ再起動なしで、処理中フラグを解除して次の決済を受けられるようにする。
    private fun resetProcessing() {
        currentDoc?.update(mapOf(
            "status" to "canceled",
            "errorMessage" to "reset（端末リセットで中止）",
            "updatedAt" to FieldValue.serverTimestamp()
        ))
        cancelInFlight {
            clearCurrentDoc()
            processing = false
            b.amount.setText("")
            status("リセットしました（前回の決済を中止し、待ち受けに戻りました）")
            refreshUi()
        }
    }

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
