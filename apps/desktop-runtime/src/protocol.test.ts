import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchCommand, dispatchScript } from "./protocol.ts";

test("dispatchCommand names node, tsx and this app by absolute path", () => {
  const command = dispatchCommand();
  assert.equal(command[0], process.execPath);
  assert.match(command[1] ?? "", /tsx[/\\].*cli\.mjs$/);
  assert.match(command[2] ?? "", /desktop-runtime[/\\]src[/\\]main\.ts$/);
  assert.equal(command[3], "dispatch");
  // A protocol handler is launched with no useful cwd, so nothing may be relative.
  for (const part of command.slice(0, 3)) assert.ok(part?.startsWith("/") || /^[A-Za-z]:/.test(part ?? ""), part);
});

test("the Windows shim runs the dispatcher hidden and cannot be injected through the URI", () => {
  const script = dispatchScript(["C:\\Program Files\\node.exe", "C:\\app\\cli.mjs", "C:\\app\\main.ts", "dispatch"]);

  assert.match(script, /shell\.Run commandLine, 0, False/, "0 is the hidden window, False does not wait");
  // VBS takes backslashes literally, so a Windows path needs no escaping inside the Array literal.
  assert.ok(
    script.includes(String.raw`parts = Array("C:\Program Files\node.exe", "C:\app\cli.mjs", "C:\app\main.ts", "dispatch")`),
    script,
  );
  assert.match(script, /Replace\(WScript\.Arguments\(i\), Chr\(34\), ""\)/, "quotes are stripped from the URI");
  assert.ok(script.includes("\r\n") && !script.includes("\n\r"), "CRLF, because Windows reads it");
  assert.ok(!script.includes("%1"), "the URI arrives as a real argument, not by substitution");

  // Windows paths cannot hold a quote; anything that does would break out of the Array literal.
  assert.throws(() => dispatchScript(['C:\\a"b\\node.exe']), /containing a quote/);
});
