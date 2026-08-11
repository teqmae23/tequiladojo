package com.tequiladojo.terminal

import android.app.Application
import com.stripe.stripeterminal.TerminalApplicationDelegate

/** Stripe Terminal SDK にアプリのライフサイクルを通知する（必須）。 */
class TerminalApp : Application() {
    override fun onCreate() {
        super.onCreate()
        TerminalApplicationDelegate.onCreate(this)
    }
}
