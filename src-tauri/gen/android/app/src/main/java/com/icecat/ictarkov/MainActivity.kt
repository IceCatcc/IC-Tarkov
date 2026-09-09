package com.icecat.ictarkov

import android.content.res.Configuration
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 屏幕常亮：手机端作为第二屏长期展示任务/地图，避免自动熄屏打断查看。
    // FLAG_KEEP_SCREEN_ON 无需任何权限，只在当前 Activity 处于前台时生效，退到后台自动释放。
    // 这里先默认开启（避免启动瞬间的熄屏），随后 Rust 启动流程会按 settings.json 的
    // keepScreenOn 同步一次；用户切换开关走 setKeepScreenOn。
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
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

  // 屏幕常亮开关：由 Rust 经 JNI 反射调用（见 proguard-rules.pro 的 keep 规则）。
  // 调用已在 UI 线程（webview 的 jni_handle 投递），直接改 window flag 即可。
  fun setKeepScreenOn(enable: Boolean) {
    if (enable) {
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    } else {
      window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
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
