package app.stremiooffline

import android.util.Log
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The Stremio addon, served on loopback so the Stremio app on this same phone can
 * install it by URL.
 *
 * Hand-rolled rather than pulled from a library: the surface is three routes, and
 * Spike 1 should not answer its question through a dependency it might not keep.
 *
 * Binds 127.0.0.1 only. Another app on the device can still reach it, which is
 * exactly how Stremio reaches it; nothing here is privileged, and nothing that
 * writes or downloads will be added without the install-secret check the desktop
 * runtime uses for /api (DESIGN section 21).
 */
class AddonServer(private val port: Int = ADDON_PORT) {

    private var socket: ServerSocket? = null
    private var pool: ExecutorService? = null

    @Volatile
    private var running = false

    val isRunning: Boolean get() = running

    fun start() {
        if (running) return
        val loopback = InetAddress.getByName("127.0.0.1")
        val server = ServerSocket(port, 16, loopback)
        socket = server
        pool = Executors.newCachedThreadPool()
        running = true
        Thread({ acceptLoop(server) }, "addon-server").start()
        Log.i(TAG, "addon server listening on 127.0.0.1:$port")
    }

    fun stop() {
        running = false
        try {
            socket?.close()
        } catch (error: IOException) {
            Log.w(TAG, "closing the listening socket failed", error)
        }
        socket = null
        pool?.shutdownNow()
        pool = null
    }

    private fun acceptLoop(server: ServerSocket) {
        while (running) {
            val client =
                try {
                    server.accept()
                } catch (error: IOException) {
                    if (running) Log.w(TAG, "accept failed", error)
                    return
                }
            pool?.execute { serve(client) }
        }
    }

    private fun serve(client: Socket) {
        client.use { connection ->
            try {
                val reader = BufferedReader(InputStreamReader(connection.getInputStream(), Charsets.UTF_8))
                val requestLine = reader.readLine() ?: return
                // Headers are read and dropped: no route here varies by them.
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                }
                val parts = requestLine.split(' ')
                val method = parts.getOrNull(0).orEmpty().uppercase()
                val path = parts.getOrNull(1).orEmpty().substringBefore('?')
                respond(connection, method, path)
            } catch (error: IOException) {
                // A client that hangs up mid-request is ordinary, not an error worth reporting.
                Log.d(TAG, "request dropped", error)
            }
        }
    }

    private fun respond(client: Socket, method: String, path: String) {
        // Stremio's web UI fetches addon endpoints cross-origin, so they must be permissive.
        val cors =
            listOf(
                "Access-Control-Allow-Origin: *",
                "Access-Control-Allow-Methods: GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers: *",
            )

        if (method == "OPTIONS") {
            write(client, 204, "No Content", null, cors, head = true)
            return
        }
        if (method != "GET" && method != "HEAD") {
            write(client, 405, "Method Not Allowed", """{"error":"method not allowed"}""", cors, method == "HEAD")
            return
        }

        val body =
            when {
                path == "/manifest.json" -> Spike1.manifestJson()
                else -> streamBody(path)
            }
        if (body == null) {
            write(client, 404, "Not Found", """{"error":"not found"}""", cors, method == "HEAD")
            return
        }
        write(client, 200, "OK", body, cors, method == "HEAD")
    }

    /** "/stream/movie/tt0816692.json" and "/stream/series/tt11280740%3A2%3A4.json". */
    private fun streamBody(path: String): String? {
        val segments = path.trim('/').split('/')
        if (segments.size != 3 || segments[0] != "stream") return null
        if (segments[1] != "movie" && segments[1] != "series") return null
        val last = segments[2]
        if (!last.endsWith(".json")) return null
        val id = decode(last.removeSuffix(".json"))
        if (id.isEmpty()) return null
        return Spike1.streamsJson(id)
    }

    private fun decode(segment: String): String =
        try {
            // Stremio percent-encodes the colons in "tt11280740:2:4"; it never sends a "+".
            URLDecoder.decode(segment, "UTF-8")
        } catch (error: IllegalArgumentException) {
            Log.d(TAG, "undecodable path segment", error)
            segment
        }

    private fun write(
        client: Socket,
        status: Int,
        reason: String,
        body: String?,
        extraHeaders: List<String>,
        head: Boolean,
    ) {
        val bytes = body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
        val headers =
            buildString {
                append("HTTP/1.1 $status $reason\r\n")
                if (body != null) append("Content-Type: application/json; charset=utf-8\r\n")
                // A 204 carries no body and, per RFC 9110, no Content-Length either.
                if (status != 204) append("Content-Length: ${bytes.size}\r\n")
                append("Cache-Control: no-store\r\n")
                append("Connection: close\r\n")
                for (header in extraHeaders) append("$header\r\n")
                append("\r\n")
            }
        val output = client.getOutputStream()
        output.write(headers.toByteArray(Charsets.US_ASCII))
        if (!head && bytes.isNotEmpty()) output.write(bytes)
        output.flush()
    }

    private companion object {
        const val TAG = "AddonServer"
    }
}
