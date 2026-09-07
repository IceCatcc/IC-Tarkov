package com.icecat.ictarkov

import android.os.Bundle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 不启用 edge-to-edge：内容从状态栏下方开始，避免系统通知栏遮挡顶部栏
    super.onCreate(savedInstanceState)
  }
}
