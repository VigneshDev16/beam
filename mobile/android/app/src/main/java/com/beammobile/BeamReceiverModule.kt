package com.beammobile

import android.content.ContentValues
import android.content.Context
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
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

class BeamReceiverModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

  companion object {
    const val PORT = 8791
    const val PREFS = "beam"
    const val KEY_DEVICE_ID = "deviceId"
    const val KEY_TRUSTED = "trustedDevices"
    val OFFER_TTL_MS = TimeUnit.MINUTES.toMillis(2)
    val TOKEN_TTL_MS = TimeUnit.MINUTES.toMillis(5)
  }

  /** One pending or approved transfer request. */
  private class Offer(
      val id: String,
      val from: String,
      val deviceId: String?,
      val files: List<Pair<String, Long>>,
      val code: String,
      val createdAt: Long = System.currentTimeMillis()
  ) {
    @Volatile var status: String = "pending"
    @Volatile var token: String? = null
    @Volatile var usesLeft: Int = 0
    val decided = CountDownLatch(1)
  }

  private var server: BeamServer? = null
  private val offers = ConcurrentHashMap<String, Offer>()
  private val random = SecureRandom()

  override fun getName() = "BeamReceiver"

  private fun prefs() = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun deviceName(): String {
    val fromSettings =
        try {
          Settings.Global.getString(ctx.contentResolver, "device_name")
        } catch (e: Exception) {
          null
        }
    return fromSettings ?: Build.MODEL ?: "Android Phone"
  }

  /** Stable per-install id, so a device we trust stays trusted. */
  private fun ownDeviceId(): String {
    val existing = prefs().getString(KEY_DEVICE_ID, null)
    if (existing != null) return existing
    val fresh = UUID.randomUUID().toString()
    prefs().edit().putString(KEY_DEVICE_ID, fresh).apply()
    return fresh
  }

  private fun trustedIds(): MutableSet<String> =
      HashSet(prefs().getStringSet(KEY_TRUSTED, emptySet()) ?: emptySet())

  private fun isTrusted(deviceId: String?) =
      deviceId != null && trustedIds().contains(deviceId)

  private fun trustDevice(deviceId: String?) {
    if (deviceId.isNullOrEmpty()) return
    val set = trustedIds()
    set.add(deviceId)
    prefs().edit().putStringSet(KEY_TRUSTED, set).apply()
  }

  private fun emit(event: String, params: Any?) {
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(event, params)
  }

  private fun sixDigitCode() = String.format("%06d", random.nextInt(1_000_000))

  private fun newToken(): String {
    val bytes = ByteArray(24)
    random.nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
  }

  private fun sweep() {
    val now = System.currentTimeMillis()
    offers.entries.removeIf { (_, o) ->
      now > o.createdAt + OFFER_TTL_MS + TOKEN_TTL_MS ||
          (o.status == "pending" && now > o.createdAt + OFFER_TTL_MS)
    }
  }

  /** Ask the UI about an offer and publish it for polling. */
  private fun askUser(offer: Offer) {
    offers[offer.id] = offer
    val files = Arguments.createArray()
    for ((name, size) in offer.files) {
      val f = Arguments.createMap()
      f.putString("name", name)
      f.putDouble("size", size.toDouble())
      files.pushMap(f)
    }
    val ev = Arguments.createMap()
    ev.putString("id", offer.id)
    ev.putString("from", offer.from)
    ev.putString("code", offer.code)
    ev.putBoolean("canTrust", !offer.deviceId.isNullOrEmpty())
    ev.putArray("files", files)
    emit("beamApprovalRequest", ev)
  }

  /** Called from JS when the user taps Accept or Decline. */
  @ReactMethod
  fun respondToOffer(id: String, accepted: Boolean, trust: Boolean, promise: Promise) {
    val offer = offers[id]
    if (offer == null || offer.status != "pending") {
      promise.resolve(false)
      return
    }
    if (accepted) {
      offer.token = newToken()
      offer.usesLeft = maxOf(1, offer.files.size)
      offer.status = "accepted"
      if (trust) trustDevice(offer.deviceId)
    } else {
      offer.status = "declined"
    }
    offer.decided.countDown()
    promise.resolve(true)
  }

  @ReactMethod
  fun getDeviceId(promise: Promise) = promise.resolve(ownDeviceId())

  @ReactMethod
  fun listTrusted(promise: Promise) {
    val arr = Arguments.createArray()
    trustedIds().forEach { arr.pushString(it) }
    promise.resolve(arr)
  }

  @ReactMethod
  fun forgetTrusted(deviceId: String, promise: Promise) {
    val set = trustedIds()
    set.remove(deviceId)
    prefs().edit().putStringSet(KEY_TRUSTED, set).apply()
    promise.resolve(true)
  }

  @ReactMethod
  fun start(promise: Promise) {
    try {
      if (server == null) {
        server = BeamServer()
        server!!.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
      }
      // Best-effort: if the service can't start, the receiver still works for
      // as long as the app is in the foreground.
      try {
        BeamService.start(ctx)
      } catch (e: Exception) {
        android.util.Log.w("Beam", "foreground service refused: " + e.message)
      }
      val res = Arguments.createMap()
      res.putInt("port", PORT)
      res.putString("name", deviceName())
      res.putString("deviceId", ownDeviceId())
      promise.resolve(res)
    } catch (e: Exception) {
      promise.reject("beam_start_failed", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    server?.stop()
    server = null
    offers.clear()
    try {
      BeamService.stop(ctx)
    } catch (e: Exception) {
      android.util.Log.w("Beam", "stopping service failed: " + e.message)
    }
    promise.resolve(null)
  }

  /**
   * A tiny string store, so the JS side can keep its own lists (devices we've
   * seen, transfers we've made) without adding an async-storage dependency for
   * two small JSON blobs.
   */
  @ReactMethod
  fun getStore(key: String, promise: Promise) {
    promise.resolve(prefs().getString("store:" + key, null))
  }

  @ReactMethod
  fun setStore(key: String, value: String, promise: Promise) {
    prefs().edit().putString("store:" + key, value).apply()
    promise.resolve(true)
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

    private fun json(status: Response.Status, obj: JSONObject) =
        newFixedLengthResponse(status, "application/json", obj.toString())

    override fun serve(session: IHTTPSession): Response {
      return try {
        sweep()
        when {
          session.method == Method.GET && session.uri.startsWith("/info") -> {
            val obj = JSONObject()
            obj.put("app", "beam")
            obj.put("name", deviceName())
            obj.put("platform", "android")
            obj.put("version", "0.3.0")
            obj.put("features", JSONArray().put("offer"))
            json(Response.Status.OK, obj)
          }

          session.method == Method.GET && session.uri.startsWith("/offer/") -> {
            val id = session.uri.removePrefix("/offer/").substringBefore('?')
            val offer = offers[id]
            val obj = JSONObject()
            if (offer == null) {
              obj.put("status", "expired")
            } else {
              obj.put("status", offer.status)
              if (offer.status == "accepted") obj.put("token", offer.token)
            }
            json(if (offer == null) Response.Status.NOT_FOUND else Response.Status.OK, obj)
          }

          session.method == Method.POST && session.uri.startsWith("/offer") -> handleOffer(session)

          session.method == Method.POST && session.uri.startsWith("/upload") -> handleUpload(session)

          else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "")
        }
      } catch (e: Exception) {
        newFixedLengthResponse(
            Response.Status.INTERNAL_ERROR, "text/plain", "error: ${e.message}")
      }
    }

    /** The sender declares itself; we answer immediately and ask the user after. */
    private fun handleOffer(session: IHTTPSession): Response {
      val body = HashMap<String, String>()
      session.parseBody(body)
      val raw = body["postData"] ?: "{}"
      val req = JSONObject(raw)

      val fileArr = req.optJSONArray("files") ?: JSONArray()
      val files = mutableListOf<Pair<String, Long>>()
      for (i in 0 until fileArr.length()) {
        val f = fileArr.optJSONObject(i) ?: continue
        files.add(Pair(f.optString("name", "file"), f.optLong("size", 0L)))
      }

      val offer =
          Offer(
              id = UUID.randomUUID().toString(),
              from = req.optString("from", "Unknown device"),
              deviceId = req.optString("deviceId", "").ifEmpty { null },
              files = files,
              code = sixDigitCode())

      val obj = JSONObject()
      obj.put("id", offer.id)
      obj.put("code", offer.code)

      // Already trusted? Skip straight past the prompt.
      if (isTrusted(offer.deviceId)) {
        offer.token = newToken()
        offer.usesLeft = maxOf(1, offer.files.size)
        offer.status = "accepted"
        offer.decided.countDown()
        offers[offer.id] = offer
        obj.put("status", "accepted")
        obj.put("token", offer.token)
      } else {
        askUser(offer)
        obj.put("status", "pending")
      }
      return json(Response.Status.OK, obj)
    }

    /**
     * Bytes only move once permission exists. A sender too old to make an offer
     * still gets a prompt here — parseBody is not called until the user agrees,
     * so a decline costs no bandwidth and writes nothing.
     */
    private fun handleUpload(session: IHTTPSession): Response {
      val token = session.parameters["token"]?.firstOrNull()
      var sender = session.parameters["from"]?.firstOrNull() ?: "Device"

      if (token != null) {
        val offer =
            offers.values.firstOrNull {
              it.status == "accepted" && it.token == token && it.usesLeft > 0
            }
                ?: return json(
                    Response.Status.FORBIDDEN, JSONObject().put("error", "not approved"))
        offer.usesLeft -= 1
        if (offer.usesLeft == 0) offer.status = "used"
        sender = offer.from
      } else {
        val legacy =
            Offer(
                id = UUID.randomUUID().toString(),
                from = sender,
                deviceId = null,
                files = emptyList(),
                code = sixDigitCode())
        askUser(legacy)
        val answered = legacy.decided.await(OFFER_TTL_MS, TimeUnit.MILLISECONDS)
        if (!answered || legacy.status != "accepted") {
          return json(Response.Status.FORBIDDEN, JSONObject().put("error", "declined"))
        }
      }

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
          BeamService.notifyArrival(ctx, displayName, sender)
        }
      }
      return json(Response.Status.OK, JSONObject().put("ok", true))
    }
  }
}
