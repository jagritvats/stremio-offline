// Spike 1, the make-or-break test of DESIGN §7 / §23: does tapping a stream
// whose externalUrl is a stremio-offline:// URI reach this runtime?
//
// Every title gets one "⬇ TEST DOWNLOAD" entry. Once the handler has fired the
// entry turns into "✅ HANDLER OK", so the answer can be read from inside
// Stremio without a terminal. Nothing is downloaded and nothing is persisted:
// the spike is a yes/no answer, not a feature.

import { buildManifest, type AddonHandlers } from "@stremio-offline/addon-core";
import type { StremioStream } from "@stremio-offline/models";
import { ACTION_SCHEME, type ActionRequest } from "./action.ts";

export interface Spike1State {
  received: number;
  last?: { id: string; at: number };
}

export function testActionUri(id: string): string {
  return `${ACTION_SCHEME}://test?id=${encodeURIComponent(id)}`;
}

export function spike1Stream(state: Spike1State, id: string): StremioStream {
  const { last } = state;
  if (last) {
    const count = `${state.received} action${state.received === 1 ? "" : "s"}`;
    return {
      name: "✅ HANDLER OK",
      description: `Runtime received ${count}, last for ${last.id} at ${new Date(last.at).toLocaleTimeString()}\nTap to test again`,
      externalUrl: testActionUri(id),
    };
  }
  return {
    name: "⬇ TEST DOWNLOAD",
    description: `Spike 1: tap to test the ${ACTION_SCHEME}:// handler\nNothing is downloaded`,
    externalUrl: testActionUri(id),
  };
}

export function spike1Handlers(state: Spike1State, version: string): AddonHandlers {
  return {
    manifest: () =>
      buildManifest({
        version,
        name: "Stremio Offline (Spike 1)",
        description:
          "Spike 1 of Stremio Offline: every title gets one ⬇ TEST DOWNLOAD entry that opens " +
          `${ACTION_SCHEME}://test. It downloads nothing.`,
        library: false,
      }),
    stream: async (_type, id) => ({ streams: [spike1Stream(state, id)] }),
  };
}

/** Record an action the runtime received. Returns the line to log and to echo to the dispatcher. */
export function spike1Action(state: Spike1State, action: ActionRequest, now: () => number = Date.now): string {
  if (action.action !== "test") return `ignored "${action.action}": spike 1 only handles test`;
  const id = action.params["id"] ?? "?";
  state.received += 1;
  state.last = { id, at: now() };
  return `received test action for ${id} (${state.received} so far)`;
}
