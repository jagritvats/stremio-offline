// The configure page, served at `/` and `/configure`.
//
// DESIGN.md section 15: the only non-Stremio interface the product actually
// needs is initial configuration. This is that page, for the hosted install.
//
// The config is assembled IN THE BROWSER and encoded into the install URL there.
// Nothing on this page is submitted to this server. That is deliberate: upstream
// transport URLs can carry debrid credentials, and section 16 asks that they not
// be uploaded to our servers. Hosting the addon means they reach us anyway once
// Stremio starts calling `/<config>/stream/...`, but there is no reason to also
// collect them a second time, in a form post, before the user has even decided
// to install. Keep it that way: no `POST` handler belongs on this page.

// Minimal HTML escaping for the one value that is echoed back into the page.
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function configurePage(existingConfig: string | undefined): string {
  const prefill = existingConfig ? esc(existingConfig) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stremio Offline</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d0b14;
    --panel: #161227;
    --line: #2a2340;
    --ink: #e8e4f3;
    --muted: #9a92b4;
    --accent: #8c5cf6;
    --warn: #f0b23a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0 16px;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 660px; margin: 0 auto; padding-block: 56px 72px; }
  h1 { font-size: 28px; margin: 0 0 6px; letter-spacing: -0.02em; }
  .tag { color: var(--muted); margin: 0 0 32px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--muted); margin: 34px 0 12px; font-weight: 600; }
  .note {
    border: 1px solid var(--line); border-left: 3px solid var(--warn);
    background: var(--panel); border-radius: 6px; padding: 14px 16px;
    color: var(--muted); font-size: 14px; margin: 0 0 8px;
  }
  .note strong { color: var(--ink); }
  .panel { background: var(--panel); border: 1px solid var(--line);
           border-radius: 8px; padding: 18px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  textarea, input[type=text] {
    width: 100%; background: #0b0912; color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  textarea { min-height: 96px; resize: vertical; }
  .qualities { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; }
  .qualities label { display: flex; align-items: center; gap: 6px;
                     color: var(--ink); font-size: 14px; margin: 0; cursor: pointer; }
  .out { margin-top: 22px; }
  code#url {
    display: block; word-break: break-all; background: #0b0912;
    border: 1px solid var(--line); border-radius: 6px; padding: 12px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    color: var(--accent);
  }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  button, a.btn {
    appearance: none; border: 1px solid var(--line); background: var(--panel);
    color: var(--ink); border-radius: 6px; padding: 10px 16px; font-size: 14px;
    cursor: pointer; text-decoration: none; display: inline-block;
  }
  a.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button:hover, a.btn:hover { border-color: var(--accent); }
  footer { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 13px; }
  ol { padding-left: 20px; color: var(--muted); }
  ol strong { color: var(--ink); }
</style>
</head>
<body>
<main>
  <h1>Stremio Offline</h1>
  <p class="tag">Mirrors the streams of your existing source addons as downloadable entries.</p>

  <p class="note">
    <strong>Pre-release.</strong> This host serves the addon manifest so Stremio can install it.
    The stream list is empty until the upstream proxy is built and the integration spikes pass.
    Downloading and offline playback run in the local runtime on your own device, not here —
    a hosted addon cannot write files to your disk.
  </p>

  <h2>Source addons</h2>
  <div class="panel">
    <label for="sources">One configured addon manifest URL per line, for example your Torrentio install URL.</label>
    <textarea id="sources" spellcheck="false" placeholder="https://torrentio.strem.fun/.../manifest.json"></textarea>

    <label style="margin-top:16px">Quality filter</label>
    <div class="qualities">
      <label><input type="checkbox" value="2160p" checked> 2160p</label>
      <label><input type="checkbox" value="1080p" checked> 1080p</label>
      <label><input type="checkbox" value="720p"> 720p</label>
      <label><input type="checkbox" value="CAM"> CAM</label>
    </div>
  </div>

  <div class="out">
    <h2>Your install URL</h2>
    <code id="url">…</code>
    <div class="row">
      <a class="btn primary" id="install" href="#">Install into Stremio</a>
      <button type="button" id="copy">Copy URL</button>
    </div>
  </div>

  <h2>After installing</h2>
  <ol>
    <li><strong>Install the runtime</strong> on the device you want the files on. The hosted addon cannot download anything by itself.</li>
    <li><strong>Open a title</strong> in Stremio. Offline entries appear alongside your normal streams.</li>
    <li><strong>Tap one</strong> to queue it. It downloads in the background and turns into an offline-playable entry when it finishes.</li>
  </ol>

  <footer>
    Your source addon URLs are encoded into the install URL by this page, in your browser.
    They are never submitted to this server by this form and nothing here is stored server-side.
  </footer>
</main>

<script>
(function () {
  var sourcesEl = document.getElementById("sources");
  var urlEl = document.getElementById("url");
  var installEl = document.getElementById("install");
  var copyEl = document.getElementById("copy");
  var boxes = Array.prototype.slice.call(document.querySelectorAll(".qualities input"));
  var prefill = ${JSON.stringify(prefill)};

  function b64url(str) {
    var b = btoa(unescape(encodeURIComponent(str)));
    return b.replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }

  function build() {
    var lines = sourcesEl.value.split("\\n")
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return /^https?:\\/\\//i.test(l); });

    var cfg = {
      sources: lines.map(function (l) { return { transportUrl: l, enabled: true }; }),
      qualities: boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; })
    };

    var seg = lines.length ? b64url(JSON.stringify(cfg)) : "";
    var path = (seg ? "/" + seg : "") + "/manifest.json";
    var https = location.origin + path;

    urlEl.textContent = https;
    // Stremio registers the stremio: scheme; the https URL is the fallback to paste by hand.
    installEl.href = "stremio:/" + "/" + location.host + path;
    return https;
  }

  // Restore an existing install URL when the page is opened at /<config>/configure,
  // which is what Stremio does when someone reconfigures an installed addon.
  if (prefill) {
    try {
      var pad = prefill.replace(/-/g, "+").replace(/_/g, "/");
      var decoded = JSON.parse(decodeURIComponent(escape(atob(pad))));
      if (decoded && decoded.sources) {
        sourcesEl.value = decoded.sources.map(function (s) { return s.transportUrl; }).join("\\n");
      }
      if (decoded && decoded.qualities) {
        boxes.forEach(function (b) { b.checked = decoded.qualities.indexOf(b.value) !== -1; });
      }
    } catch (e) { /* a malformed segment just leaves the form empty */ }
  }

  sourcesEl.addEventListener("input", build);
  boxes.forEach(function (b) { b.addEventListener("change", build); });
  copyEl.addEventListener("click", function () {
    navigator.clipboard.writeText(build()).then(function () {
      copyEl.textContent = "Copied";
      setTimeout(function () { copyEl.textContent = "Copy URL"; }, 1400);
    });
  });

  build();
})();
</script>
</body>
</html>`;
}
