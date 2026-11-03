// Step-change blip (Web Audio oscillator, no files). The context is created
// inside the tap chain like unlockSpeech(): iOS gates audio on gestures.

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!context) context = new Ctor();
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    return null;
  }
}

/** Prime the audio chain from a user tap; call before any async work. */
export function unlockBeep(): void {
  getContext();
}

/** One short confirmation blip. Best-effort: silence never blocks the UI. */
export function beep(frequencyHz = 660, durationMs = 120): void {
  try {
    const audio = getContext();
    if (!audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = frequencyHz;
    gain.gain.setValueAtTime(0.2, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + durationMs / 1000);
  } catch {
    // Silence is fine; speech and text carry the step.
  }
}
