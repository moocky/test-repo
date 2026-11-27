package expo.modules.audioroute

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AudioRouteModule : Module() {
  private var callback: AudioDeviceCallback? = null

  private val audioManager: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("AudioRoute")

    Events("onChange")

    Function("getCurrentRoute") {
      currentRoute()
    }

    OnStartObserving {
      val cb = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = emitChange()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = emitChange()
      }
      callback = cb
      audioManager?.registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
    }

    OnStopObserving {
      callback?.let { audioManager?.unregisterAudioDeviceCallback(it) }
      callback = null
    }
  }

  private fun emitChange() {
    val route = currentRoute()
    sendEvent(
      "onChange",
      Bundle().apply {
        putBoolean("headphones", route["headphones"] as Boolean)
        putString("type", route["type"] as String)
        putString("name", route["name"] as String)
      }
    )
  }

  /** Headphone-like outputs: sound does not leak back into the phone's microphone. */
  private fun kindOf(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    else -> null
  }

  private fun currentRoute(): Map<String, Any> {
    val devices = audioManager?.getDevices(AudioManager.GET_DEVICES_OUTPUTS) ?: emptyArray()
    for (device in devices) {
      val kind = kindOf(device.type) ?: continue
      return mapOf("headphones" to true, "type" to kind, "name" to device.productName.toString())
    }
    return mapOf("headphones" to false, "type" to "speaker", "name" to "")
  }
}
