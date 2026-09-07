package com.icecat.ictarkov

import android.content.res.Configuration
import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // edge-to-edge（Android 15+ 强制）：系统栏/挖孔 inset 转根布局 padding
    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    applySystemBars()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBars()
  }

  // 横屏隐藏系统状态栏（沉浸模式，下拉可临时呼出），竖屏恢复。
  // 隐藏后 systemBars 顶部 inset 归零，insets 监听会自动收窄内容顶部 padding。
  private fun applySystemBars() {
    val c = WindowInsetsControllerCompat(window, window.decorView)
    val landscape =
      resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    if (landscape) {
      c.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      c.hide(WindowInsetsCompat.Type.statusBars())
    } else {
      c.show(WindowInsetsCompat.Type.statusBars())
    }
  }
}
