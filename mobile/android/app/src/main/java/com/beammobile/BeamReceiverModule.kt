package com.beammobile

import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import org.json.JSONObject

class BeamReceiverModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

  companion object {
    const val PORT = 8791
  }

  private var server: BeamServer? = null

  override fun getName() = "BeamReceiver"

  private fun deviceName(): String {
    val fromSettings =
        try {
          Settings.Global.getString(ctx.contentResolver, "device_name")
        } catch (e: Exception) {
          null
        }
    return fromSettings ?: Build.MODEL ?: "Android Phone"
  }

  private fun emit(event: String, params: Any?) {
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(event, params)
  }

  @ReactMethod
  fun start(promise: Promise) {
    try {
      if (server == null) {
        server = BeamServer()
        server!!.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
      }
      val res = Arguments.createMap()
      res.putInt("port", PORT)
      res.putString("name", deviceName())
      promise.resolve(res)
    } catch (e: Exception) {
      promise.reject("beam_start_failed", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    server?.stop()
    server = null
    promise.resolve(null)
  }

  // Required no-ops for NativeEventEmitter
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  /** Copy a received temp file into the public Downloads/Beam folder via MediaStore. */
  private fun saveToDownloads(tmpPath: String, displayName: String): String? {
    val values =
        ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, displayName)
          put(MediaStore.Downloads.RELATIVE_PATH, "Download/Beam")
        }
    val resolver = ctx.contentResolver
    val uri =
        resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
    resolver.openOutputStream(uri)?.use { out ->
      FileInputStream(File(tmpPath)).use { it.copyTo(out) }
    }
    return uri.toString()
  }

  inner class BeamServer : NanoHTTPD(PORT) {
    override fun serve(session: IHTTPSession): Response {
      return try {
        when {
          session.method == Method.GET && session.uri.startsWith("/info") -> {
            val json = JSONObject()
            json.put("app", "beam")
            json.put("name", deviceName())
            json.put("platform", "android")
            json.put("version", "0.1.0")
            newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
          }
          session.method == Method.POST && session.uri.startsWith("/upload") -> {
            val sender = session.parameters["from"]?.firstOrNull() ?: "Device"
            val files = HashMap<String, String>()
            session.parseBody(files) // field -> temp file path
            val saved = mutableListOf<String>()
            for ((field, tmpPath) in files) {
              val original = session.parameters[field]?.firstOrNull() ?: "unnamed"
              val displayName = File(original).name
              val uri = saveToDownloads(tmpPath, displayName)
              if (uri != null) {
                saved.add(displayName)
                val ev = Arguments.createMap()
                ev.putString("name", displayName)
                ev.putString("uri", uri)
                ev.putString("sender", sender)
                emit("beamReceived", ev)
              }
            }
            val json = JSONObject()
            json.put("ok", true)
            newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
          }
          else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "")
        }
      } catch (e: Exception) {
        newFixedLengthResponse(
            Response.Status.INTERNAL_ERROR, "text/plain", "error: ${e.message}")
      }
    }
  }
}
