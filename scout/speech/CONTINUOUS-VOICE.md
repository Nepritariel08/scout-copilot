# Owned continuous voice turn taking

The owner selected continuous hands-free voice on 2026-11-03 (WI184 / primary
AI Enablement issue4), superseding PTT-only milestone scope. This client-only
slice adds continuous turn taking on top of the existing pinned local STT/TTS
and approved normal Scout model/history route. PTT remains available separately.
It adds no provider, credential, model policy, audio archive, scheduler, server
endpoint, device action or business permission. Business actions retain normal
DSH drafting/review and execution rights.

## Integration contract

Mount `OwnedVoiceConversation` above the normal conversation with these props:

```ts
{
  enabled: qualifiedLocalSpeechAvailable,
  blocked: externalConversationOrPermissionBlock,
  identityKey: `${nativeUserId}:${channelId}`,
  ask: async (text, signal) => ({ threadId, messageId }),
  cancelOwnTurn: () => cancelOnlyTheExactVoiceOwnedRun(),
  onBusyChange: (busy) => setOwnedSessionBusy(busy),
}
```

Also key the React component by that verified native/channel identity. Keep
`cancelOwnTurn` stable per identity and capture its exact voice-run target. The
component preserves the old identity's cancellation callback during a transition;
never implement it as a generic "stop whatever is currently running" action.

`ask` must send exactly one new normal chat turn, honor its abort signal and
native/channel scope, then resolve only after fresh authorized history identifies
the new completed saved assistant message. Return exactly `{threadId,messageId}`;
no assistant text, URL, model/provider selection or guessed stream-message ID.
Unknown run/history/network outcomes reject; do not resend the turn or silently
call another provider. The existing model's hard 20/day cap, output512/cost gates
and release consent remain unchanged. TTS uses only saved identity and the existing
server's current authorization/context checks.

`onBusyChange` is true while starting/listening/transcribing/asking/speaking, and
while a stopped ask is still settling. Block typed/PTT sends and source/agent
selection during it; Stop remains visible. Do not pass the voice-owned run's own
`isRunning` as `blocked`, which would cancel every voice ask. A genuinely external
run, source/permission change or identity transition must block/pause voice.

## Observable behavior and bounds

- Start is an explicit click. It creates/resumes one AudioContext in that user
  gesture, then requests browser microphone permission. Mount, capability discovery,
  recovery and returning to a visible page never start it automatically.
- Local browser signal analysis waits for sustained speech-like energy/zero-crossing
  frames and a one-second quiet tail. This is a heuristic utterance gate, **not a
  semantic speech classifier**. It rejects silence, clipped/broadband noise and
  steady hum patterns in deterministic fixtures; actual room/browser/microphone
  behavior still needs device acceptance. It sends no audio features externally.
- A quiet/noise-only recording rolls over locally after 30 seconds without an STT
  or model call. A 30 second clip without a complete spoken utterance is discarded
  and the session pauses. Never use the time cap as a reason to submit noise or
  a partial sentence. Finished clips over 2 MiB are refused before STT; the server's
  actual decoded-duration/upload bounds remain authoritative.
- On an utterance, finish/stop the microphone and disconnect its analysis graph;
  only then transcribe, call `ask` once, request saved-answer TTS and play. No
  microphone is open while ASR/model/TTS/playback is in progress. After successful
  playback ends, reopen listening automatically. There is no barge-in/overlap.
- The same click-resumed context decodes/plays the authorized WAV. If playback is
  suspended/blocked or any step fails, pause with visible notice. Do not demand
  repeated autoplay taps as an automatic loop, re-ask, or restart listening.
- One session ends at 8 model turns or 10 minutes (including permission/network time).
  Explicit Start can begin a new session; daily server limits still apply.
- Stop, pagehide, visibility hidden, disabled/blocked state and native/channel
  changes stop capture/playback, close the context, abort in-flight work and discard
  late generations. Cancel the exact model turn only if this voice session owns
  an unresolved ask. Its promise must settle before a new session may start;
  an unknown outcome is never replayed automatically.

Raw recording blobs, decoded audio and detector frames are transient client
memory; the normal submitted transcript and saved reply use existing owned history.
The local speech service retains its qualified private temporary cleanup rules.
The transcript is sent automatically **within a user-started continuous session**;
this is the intentional difference from the separately available review-before-Send
PTT flow. No wake-word/background listening is added.

## Evidence and remaining acceptance

Focused tests use synthetic streams/audio, injected timers and deterministic
callbacks: complete cycle; no echo/duplicate asks; silence/noise local rollover;
30 second discard; Stop/late callback at every phase; saved-ID-only TTS; unknown
outcomes without retry; native/channel/pagehide/blocked transitions; autoplay
pause; 8 turn/10 minute bounds. No test records a real microphone or calls a provider.

Before calling this hands-free usable, validate the exact integrated source over
HTTPS in Windows and the actual Huawei browser: permission, signal gating in the
owner's room, Start/Stop, complete spoken turn, one saved normal model answer,
automatic authorized spoken response, automatic return to listening without echo,
hidden/tab/channel transitions, denial/unknown outcomes and session limits. Browser
AudioContext policies can prevent continuous playback; that browser must pause
clearly and keep the existing PTT fallback, without enabling cloud realtime voice.
Primary API reference: [Web Audio AudioContext.resume](https://www.w3.org/TR/webaudio-1.1/#dom-audiocontext-resume).
