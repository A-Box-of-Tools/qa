# Offline pairing coverage

The five Connect Devices tools share connection choices and manual block I/O,
but each tool still owns its consent, media and participant rules. The browser
suite checks those adapters as well as the shared controls.

`tests/offline-pairing.spec.ts` runs on Chromium and WebKit at desktop and phone
viewports. It loads each page with the browser's offline hint set before startup,
checks that Automatic selects Offline, preserves a typed block, respects an
explicit Offline choice and URL, and rejects malformed or cross-tool offers
without capture or a native peer. Source gates follow the template fragments;
an older production page skips the new controls explicitly.

`lib/offline-pairing.ts` counts every WebSocket constructor before refusing it.
This includes discovery and exceptions that application code catches. Native
journeys must therefore work without even attempting a discovery, introduction
or relay socket. Both exported descriptions must contain gathered host
candidates and only a data channel, and every native peer must use an empty
ICE-server list. The suite does not substitute SDP, data channels or media
transport.

The native tool journeys cover:

- Share Text: private reader admission, exact text and file bytes, live edits,
  independent reader exchanges and terminal Stop.
- Share a Browser Tab: the existing single-viewer exchange, saved block files,
  explicit approval and acknowledgement before video, invalid/stale/expired
  replies and Stop. Its existing Automatic and online journeys also run.
- Remote Camera: separate exchanges for two viewers, approval popup and delayed
  acknowledgement before media, native decoded frames, no viewer capture,
  stale/expired replies and capture/peer cleanup on Stop.
- Local Walkie-Talkie: two receive-only listeners, initially quiet host capture,
  explicit talking, native received audio, quiet foreground return and End.
- Voice Oncall: reply creation without microphone capture, separate Connect and
  Talk actions, password rejection/retry, two callers, host mute/unmute/removal
  and End. Cancel after password refusal and Disconnect during a delayed
  microphone response retire the entire attempt, including a late track.
  Both voice adapters reject stale/expired pending exchanges.

The native camera/display/audio journeys run in Chromium because this suite's
Linux WebKit build cannot supply the media fixtures those cases require. These
are explicit capability exclusions, separate from source-gated production
skips. The all-engine control tests still run in WebKit.

The offline hint is controlled while page assets remain reachable. It is not a
claim that a page can be installed for the first time without internet, that a
browser's online flag proves local reachability, or that a hotspot permits
device-to-device traffic. The installed-shell tests remain separate. Physical
iPhone–Android and separate-computer checks are still needed for multicast name
resolution, managed-device restrictions, hotspot isolation, real permission
prompts and actual OS lock/unlock. Simulated visibility events verify application
intent boundaries only.
